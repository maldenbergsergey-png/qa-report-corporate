# Repository rules

Every user-visible change must update `release-notes.js` before the task is complete. Reuse the existing top release when it has the current date, add every change made that day to that single release, and describe changes briefly for users without implementation details.

Keep the current version and release date aligned with `../qa-report` when the sibling repository is available. When the version changes, update `package.json`, the root version fields in `package-lock.json` when present, the top `release-notes.js` entry, its resource version, and the PWA cache version. Run `npm run check` before committing.
