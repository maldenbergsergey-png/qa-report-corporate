# Развёртывание QA Report: простая инструкция

## Что в итоге увидит пользователь

1. Пользователь открывает QA Report и входит корпоративным email/паролем.
2. Первый раз открывает «Настройки → Jira» и нажимает «Подключить» для нужной Jira.
3. Jira использует свой корпоративный вход и показывает подтверждение доступа QA Report.
4. После подтверждения пользователь возвращается в QA Report. Ручная генерация token не нужна.
5. Комментарии и вложения публикуются от Jira-учётки пользователя и с её permissions.
6. Jira 7.3.2 и Jira 8.11.1 подключаются независимо. Можно подключить только ту, которой пользуется сотрудник.

Общий LDAP упрощает вход, но не заменяет OAuth: браузерная Jira-сессия и AD-пароль не могут безопасно передаваться
серверу QA Report. OAuth-подтверждение выполняется один раз для каждой Jira и затем отображается в профиле Jira в
разделе OAuth Access Tokens.

## Кто что делает

### Владелец продукта

- предоставляет DevOps адрес репозитория;
- сообщает публичный адрес QA Report;
- проводит приёмочную проверку двумя обычными пользователями.

### Администратор Active Directory

- выдаёт read-only service account для LDAP search;
- предоставляет LDAPS URL, search base, TLS server name, корпоративный CA и его SHA-256 fingerprint;
- разрешает серверу QA Report подключаться к AD по TCP 636.

### Администратор каждой Jira

В Jira 7.3.2 и Jira 8.11.1 отдельно создаёт входящий OAuth 1.0a Application Link:

- Application name: `QA Report`;
- Application URL: публичный HTTPS URL QA Report;
- Consumer key: `qa-report`;
- Consumer name: `QA Report`;
- Public key: содержимое `jira_oauth_public.pem` без приватного ключа;
- OAuth flow: three-legged OAuth 1.0a;
- callback: `https://<qa-report-domain>/api/jira/oauth/callback`.

Администратор также проверяет, что обычные пользователи имеют Browse Projects, Add Comments и Create Attachments
permissions в нужных проектах. 2-Legged OAuth impersonation не используется: Atlassian документирует
его для связей между Atlassian-приложениями, а QA Report является самостоятельным приложением.

### DevOps

- подготавливает Linux-сервер с Docker/Compose во внутренней сети;
- создаёт secrets и `.env` вне Git;
- настраивает DNS, HTTPS reverse proxy и backup volume `reports_data`;
- запускает контейнер и проверяет healthcheck;
- не публикует порт приложения напрямую во внешнюю сеть;
- синхронизирует время сервера через NTP — OAuth 1.0a чувствителен к рассинхронизации часов.

## Шаги после merge в удалённый репозиторий

### 1. Скачать проект на сервер

```bash
git clone <URL корпоративного репозитория>
cd qa-report-corporate
```

При повторном развёртывании используется корпоративный CI/CD либо `git pull` с последующей пересборкой.

### 2. Создать ключи и secrets

```bash
mkdir -p secrets
openssl rand -base64 48 > secrets/auth_secret
openssl rand -base64 48 > secrets/jira_token_encryption_key
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out secrets/jira_oauth_private.pem
openssl pkey -in secrets/jira_oauth_private.pem -pubout -out secrets/jira_oauth_public.pem
```

Также создать:

```text
secrets/ldap_bind_password
secrets/ldap_ca.pem
secrets/storage_access_key
secrets/storage_secret_key
```

`jira_oauth_public.pem` передаётся администраторам обеих Jira. `jira_oauth_private.pem`, encryption key, LDAP
password и другие secrets никому не передаются и не коммитятся.

### 3. Настроить `.env`

```bash
cp .env.example .env
```

Заменить примерные домены на реальные. В `JIRA_INSTANCES_JSON` должны быть обе Jira. Пример:

```env
JIRA_OAUTH_CONSUMER_KEY=qa-report
JIRA_INSTANCES_JSON=[{"id":"jira-7","name":"Jira Legacy","version":"7.3.2","baseUrl":"https://jira7.company.ru"},{"id":"jira-8","name":"Jira Main","version":"8.11.1","baseUrl":"https://jira8.company.ru"}]
QA_JIRA_ALLOWED_ORIGINS=https://jira7.company.ru,https://jira8.company.ru
JIRA_REQUIRE_EMAIL_MATCH=true
```

### 4. Зарегистрировать Application Link в обеих Jira

Сначала DevOps передаёт публичный ключ Jira-администраторам. После создания links consumer key в Jira и `.env`
должен совпадать. Приватный ключ должен соответствовать переданному public key.

### 5. Запустить

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100 qa-report
curl http://127.0.0.1:4173/api/health
```

### 6. Настроить HTTPS

Использовать примеры из `deploy/`, заменить домен и сертификаты. Reverse proxy должен перезаписывать forwarded
headers, удалять browser identity/Authorization headers и оставлять порт 4173 доступным только локально.

## Приёмочная проверка

Для каждой Jira выполнить отдельно:

1. Обычный пользователь входит в QA Report через AD.
2. Нажимает «Подключить» и подтверждает доступ в Jira.
3. QA Report показывает Jira как подключённую и имя пользователя.
4. Пользователь вставляет ссылку на заранее созданную Jira-задачу и публикует QA Report.
5. В задаче появляется комментарий, author которого совпадает с пользователем.
6. Вложения комментария также загружены его Jira-учёткой.
7. Второй пользователь не использует OAuth token первого и проходит собственное подключение.
8. После отзыва token в Jira следующая операция требует повторного подключения.
9. Пользователь без Add Comments/Create Attachments permissions получает 403 без fallback на более привилегированную учётку.

## Если администратор Jira не разрешает Application Link

Требование «публиковать комментарий от имени пользователя» выполнить безопасно нельзя. Нельзя заменять OAuth
хранением AD/Jira-пароля, копированием browser cookie или service account: в последнем случае реальным автором
комментария останется service account.
