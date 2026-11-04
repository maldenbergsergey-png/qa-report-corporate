# Repository rules

Review `release-notes.js` for every user-visible change before the task is complete. Reuse the existing top release when it has the current date and describe the result briefly for users without implementation details. For new features in that release, revise the existing item if needed and omit separate entries for fixes found while testing or polishing the feature.

Follow the «Как писать для конечного пользователя» rules in [README.md](README.md). Include only concrete user actions, benefits, or visible fixes; omit internal-only work and review new items for clarity, relevance, and duplication.

Keep the current version and release date aligned with `../qa-report` when the sibling repository is available. When the version changes, update `package.json`, the root version fields in `package-lock.json` when present, the top `release-notes.js` entry, its resource version, and the PWA cache version. Run `npm run check` before committing.
