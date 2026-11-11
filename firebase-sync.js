/* Kitap Rafı Firebase sync: Firestore only, compatible with Spark plan. */
(function(){
 const config={apiKey:"AIzaSyBZZ99E0leWz6ZZAZd-BuEZH45g3Bup7o0",authDomain:"kitap-rafi.firebaseapp.com",projectId:"kitap-rafi",storageBucket:"kitap-rafi.firebasestorage.app",messagingSenderId:"174748881416",appId:"1:174748881416:web:26dd723bec35e5bc5737bd"};
 firebase.initializeApp(config);
 const auth=firebase.auth(), fs=firebase.firestore(), CHUNK=600000;
 let user=null, busy=false, debounce=null;
 const status=t=>{const e=document.getElementById('firebaseSyncStatus');if(e)e.textContent=t;};
 const root=()=>{if(!user)throw Error('Google hesabıyla giriş yapmalısın.');return fs.collection('users').doc(user.uid);};
 function toB64(bytes){let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);}
 function fromB64(s){const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
 async function waitStorage(){while(!window.appStorageReady)await new Promise(r=>setTimeout(r,50));await window.appStorageReady;}
 window.firebaseSignIn=async()=>{try{await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());}catch(e){if(e.code==='auth/popup-blocked'||e.code==='auth/operation-not-supported-in-this-environment')await auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());else window.cloudSyncError(e);}};
 window.firebaseSignOut=()=>auth.signOut();
 window.cloudSyncError=e=>{console.error(e);status('Eşitleme hatası');if(window.showToast)window.showToast('Eşitleme hatası: '+(e.message||e.code||'Bilinmeyen hata'));};
 window.queueCloudSync=()=>{if(!user||busy)return;clearTimeout(debounce);debounce=setTimeout(()=>syncMeta().catch(window.cloudSyncError),1000);};
 async function syncMeta(){
  if(!user||busy)return;busy=true;status('Buluta eşitleniyor…');
  try{
   const r=root(),books=JSON.parse(localStorage.getItem('kitaplik_books')||'[]'),stats=JSON.parse(localStorage.getItem('kitaplik_stats')||'{}'),timers=JSON.parse(localStorage.getItem('kitaplik_reading_timers')||'{}'),bookmark=JSON.parse(localStorage.getItem('kitaplik_reading_bookmark')||'null');
   for(let i=0;i<books.length;i+=400){const batch=fs.batch();books.slice(i,i+400).forEach(b=>batch.set(r.collection('books').doc(b.id),{...b,updatedAt:b.updatedAt||Date.now()}));await batch.commit();}
   await Promise.all([
    r.collection('appData').doc('stats').set({value:stats,updatedAt:stats.updatedAt||Date.now()}),
    r.collection('appData').doc('timers').set({value:timers,updatedAt:Date.now()}),
    bookmark?r.collection('appData').doc('bookmark').set({value:bookmark,updatedAt:bookmark.updatedAt||Date.now()}):Promise.resolve()
   ]);
   status('Bulutla eşitlendi');
  }finally{busy=false;}
 }
 window.cloudUploadFile=async(id,input,kind)=>{
  if(!user)return;const bytes=input instanceof Uint8Array?input:new Uint8Array(input),encoded=toB64(bytes),ref=root().collection('files').doc(id),old=await ref.get();
  if(old.exists){const snap=await ref.collection('chunks').get();for(let i=0;i<snap.docs.length;i+=400){const batch=fs.batch();snap.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));await batch.commit();}}
  const count=Math.ceil(encoded.length/CHUNK);
  for(let i=0;i<count;i++)await ref.collection('chunks').doc(String(i).padStart(6,'0')).set({index:i,data:encoded.slice(i*CHUNK,(i+1)*CHUNK)});
  await ref.set({kind,chunkCount:count,byteLength:bytes.length,updatedAt:Date.now()});
  status('PDF/metin buluta yüklendi');
 };
 window.cloudDownloadFile=async id=>{
  const ref=root().collection('files').doc(id),meta=await ref.get();if(!meta.exists)throw Error('Bu kitabın bulut dosyası henüz yüklenmemiş.');
  const chunks=await ref.collection('chunks').orderBy('index').get();let data='';chunks.forEach(d=>data+=d.data().data);
  const bytes=fromB64(data);
  if(meta.data().kind==='text')await window.idbSet('texts',id,new TextDecoder().decode(bytes));
  else await window.idbSet('pdfs',id,bytes.buffer);
  return bytes;
 };
 window.cloudDeleteBook=async id=>{
  const r=root(),f=r.collection('files').doc(id),snap=await f.collection('chunks').get();
  for(let i=0;i<snap.docs.length;i+=400){const batch=fs.batch();snap.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref));await batch.commit();}
  await Promise.all([f.delete(),r.collection('books').doc(id).delete()]);
 };
 async function restore(){
  if(!user||busy)return;await waitStorage();busy=true;status('Kayıtlar indiriliyor…');
  try{
   const r=root(),remote=await r.collection('books').get(),local=JSON.parse(localStorage.getItem('kitaplik_books')||'[]'),map=new Map(local.map(b=>[b.id,b]));
   remote.forEach(d=>{const b=d.data(),old=map.get(d.id);if(!old||(b.updatedAt||0)>(old.updatedAt||0))map.set(d.id,b);});
   localStorage.setItem('kitaplik_books',JSON.stringify([...map.values()]));
   const names=['stats','timers','bookmark'],docs=await Promise.all(names.map(n=>r.collection('appData').doc(n).get()));
   docs.forEach((d,i)=>{if(!d.exists)return;const key=['kitaplik_stats','kitaplik_reading_timers','kitaplik_reading_bookmark'][i],localVal=JSON.parse(localStorage.getItem(key)||'null'),remoteVal=d.data().value,localTime=localVal?.updatedAt||0;if(!localVal||(d.data().updatedAt||0)>localTime)localStorage.setItem(key,JSON.stringify(remoteVal));});
   if(window.renderLibrary)window.renderLibrary();if(window.renderReadingBookmark)window.renderReadingBookmark();
   busy=false;await syncMeta();
   for(const b of [...map.values()]){
    const file=await r.collection('files').doc(b.id).get();
    if(!file.exists){try{const v=b.type==='pdf'?await window.idbGet('pdfs',b.id):await window.idbGet('texts',b.id);if(v)await window.cloudUploadFile(b.id,b.type==='pdf'?new Uint8Array(v):new TextEncoder().encode(v),b.type);}catch(e){console.warn('Dosya aktarımı atlandı',b.id,e);}}
   }
   status('Kayıtlar eşitlendi');
  }finally{busy=false;}
 }
 auth.onAuthStateChanged(async u=>{
  user=u;const btn=document.getElementById('firebaseAuthBtn');
  if(btn){btn.textContent=u?'Çıkış Yap':'Google ile Giriş';btn.onclick=u?window.firebaseSignOut:window.firebaseSignIn;}
  if(!u){status('Cihazda kayıtlı');return;}
  try{await restore();}catch(e){window.cloudSyncError(e);}
 });
})();