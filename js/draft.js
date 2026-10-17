// 작업 중인 내용을 이 브라우저에 임시 보관한다(창을 닫아도 [이어서 하기]). 내 기기 브라우저 안에만 남는다.
// 백업 파일은 GPS 원래 측정이 붙어 수 MB 가 될 수 있어 localStorage(약 5MB) 대신 IndexedDB 를 쓴다.

const DB = 'golfscore-web';
const STORE = 'draft';
const KEY = 'current';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** { backupText, originals: { rounds: [[id, json]], clubs: [[id, json]] }, fileName, savedAt } */
export async function saveDraft(draft) {
  try {
    await run('readwrite', (s) => s.put(draft, KEY));
    return true;
  } catch {
    return false; // 사생활 보호 창 등. 임시 보관 없이 계속 쓸 수 있다.
  }
}

export async function loadDraft() {
  try {
    return (await run('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function clearDraft() {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch {
    // 지울 것이 없으면 그만
  }
}
