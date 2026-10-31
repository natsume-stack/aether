import type {VoxelEditor} from '../editor';
type Data=Awaited<ReturnType<VoxelEditor['projectManager']['getData']>>;
type Snapshot={data:Data;fingerprint:string;createdAt:number};
async function database():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('box3-voxa-ai-snapshots',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('latest');
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(new Error('无法打开 AI 快照存储'));
  });
}
async function transaction<T>(key:string,mode:IDBTransactionMode,action:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db=await database();
  try {return await new Promise<T>((resolve,reject)=>{
    const tx=db.transaction('latest',mode);const request=action(tx.objectStore('latest'));
    tx.oncomplete=()=>resolve(request.result);tx.onerror=tx.onabort=()=>reject(new Error('AI 快照保存失败，请检查浏览器存储空间'));
  });} finally {db.close();}
}
export async function storeAiSnapshot(key:string,data:Data,fingerprint:string) {
  await transaction(key,'readwrite',s=>s.put({data,fingerprint,createdAt:Date.now()} satisfies Snapshot,key));
}
export async function loadAiSnapshot(key:string):Promise<Snapshot|undefined> {
  return transaction(key,'readonly',s=>s.get(key));
}
export async function removeAiSnapshot(key:string) {await transaction(key,'readwrite',s=>s.delete(key));}
