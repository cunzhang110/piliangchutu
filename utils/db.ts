export const initDB = () => {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('GeminiImageDB', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('tasks')) {
        db.createObjectStore('tasks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
    };
  });
};

export const saveTasksToDB = async (tasks: any[]) => {
  try {
    const db = await initDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tasks', 'readwrite');
      const store = tx.objectStore('tasks');
      store.clear();
      tasks.forEach(task => store.put(task));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to save tasks to DB', e);
  }
};

export const loadTasksFromDB = async () => {
  try {
    const db = await initDB();
    return new Promise<any[]>((resolve, reject) => {
      const tx = db.transaction('tasks', 'readonly');
      const store = tx.objectStore('tasks');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('Failed to load tasks from DB', e);
    return [];
  }
};

export const saveSettingsToDB = async (settings: any) => {
  try {
    const db = await initDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      store.put({ id: 'global', ...settings });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to save settings to DB', e);
  }
};

export const loadSettingsFromDB = async () => {
  try {
    const db = await initDB();
    return new Promise<any>((resolve, reject) => {
      const tx = db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const request = store.get('global');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('Failed to load settings from DB', e);
    return null;
  }
};
