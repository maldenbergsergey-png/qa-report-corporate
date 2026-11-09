# Repository rules

Review `release-notes.js` for every user-visible change before the task is complete. Group entries by user capability; a commit alone does not require an item. Reuse the existing top release when it has the current date and describe the result briefly for users without implementation details. Describe each new feature once with its final capabilities; revise its published item as needed and omit separate improvements or fixes to that feature on the same date.

Follow the «Как писать для конечного пользователя» rules in [README.md](README.md). Include only brief, concrete user actions, benefits, or significant visible fixes. Never publish administrative changes, including admin-panel features or fixes. Omit internal-only work and minor visual polish; review new items for clarity, relevance, and duplication.

Keep the current version and release date aligned with `../qa-report` when the sibling repository is available. When the version changes, update `package.json`, the root version fields in `package-lock.json` when present, the top `release-notes.js` entry, its resource version, and the PWA cache version. Run `npm run check` before committing.
