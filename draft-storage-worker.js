importScripts("/history-content.js?v=1");

// Read metadata from the existing database off the UI thread. Its records and
// attachments stay in the original format; this worker never writes or migrates.
self.addEventListener("message", async ({ data }) => {
  const { requestId, databaseName, databaseVersion, storeName, reportId } = data;
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, databaseVersion);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(reportId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
    let metadata;
    if (record) {
      const { reportId, publicId, draftId, revision, updatedAt, lastSavedBy, lastSavedClientId } = record.document || {};
      metadata = { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, historyComment: record.historyComment,
        historyContentFingerprint: record.historyContentFingerprint || QaReportHistory.contentFingerprint(record.document || {}),
        document: { reportId, publicId, draftId, revision, updatedAt, lastSavedBy, lastSavedClientId } };
    }
    self.postMessage({ requestId, metadata });
  } catch (error) {
    self.postMessage({ requestId, error: String(error?.message || error) });
  } finally {
    db?.close();
  }
});
