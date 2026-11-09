// Only ciphertext is published. A remembered non-extractable key stays in IndexedDB.
const base=new URL('./',import.meta.url);
const decoder=new TextDecoder();
const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const hex=value=>[...new Uint8Array(value)].map(n=>n.toString(16).padStart(2,'0')).join('');
const aadKey=id=>new TextEncoder().encode('liellatu:key:v1:'+id);
const aadBook=new TextEncoder().encode('liellatu:book:v1');
const aadChunk=new TextEncoder().encode('liellatu:chunk:v1');
const gzipHeader=Uint8Array.of(0x1f,0x8b,8,0,0,0,0,0,0,0xff),finalBlock=Uint8Array.of(3,0);
const isReader=document.body.hasAttribute('data-liellatu-reader');
let manifestPromise,globalsPromise,activeKey,blobURL;
function startingVolume(meta){
  try{return Math.max(0,meta.volumes.findIndex(v=>v.volume===Number(localStorage.getItem('liellatu-web-volume-v1'))));}catch{return 0;}
}

function accessDB(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('liellatu-access-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('keys',{keyPath:'id'});
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
}
async function cached(mode,value){
  const db=await accessDB();
  try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('keys',mode==='get'?'readonly':'readwrite'),store=tx.objectStore('keys');
    const request=mode==='get'?store.get('book'):mode==='set'?store.put({id:'book',...value}):store.delete('book');
    let answer;request.onsuccess=()=>{answer=request.result;};tx.oncomplete=()=>resolve(answer);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
}
async function metadata(){
  if(!manifestPromise)manifestPromise=fetch(new URL('manifest.json',base),{cache:'no-store'}).then(async response=>{
    if(!response.ok)throw new Error('Книга временно недоступна. Попробуйте ещё раз позже.');
    const value=await response.json();
    if(![1,2,3].includes(value.format_version)||!value.volumes?.length||value.access?.kdf?.iterations<210000)throw new Error('Не удалось открыть выпуск книги.');
    return value;
  }).catch(error=>{manifestPromise=null;throw error;});
  return manifestPromise;
}
async function unlock(username,password,meta){
  const access=meta.access;
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(username+'\0'+password),'PBKDF2',false,['deriveKey']);
  const wrapping=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:access.kdf.iterations,salt:bytes(access.kdf.salt)},material,{name:'AES-GCM',length:256},false,['decrypt']);
  let raw;
  try{raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(access.wrapped_key.iv),additionalData:aadKey(access.key_id)},wrapping,bytes(access.wrapped_key.data));}
  catch{throw new Error('Неверное имя пользователя или пароль.');}
  const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
  new Uint8Array(raw).fill(0);return key;
}
async function decryptPayload(key,volume,expected){
  if(!/^book-[0-9a-f]{64}\.bin$/.test(volume.file))throw new Error('Не удалось открыть выпуск книги.');
  const response=await fetch(new URL(volume.file,base),{cache:'no-cache'});
  if(!response.ok)throw new Error('Книга временно недоступна. Попробуйте ещё раз позже.');
  const cipher=await response.arrayBuffer();
  if(hex(await crypto.subtle.digest('SHA-256',cipher))!==volume.cipher_sha256)throw new Error('Не удалось загрузить книгу целиком. Попробуйте ещё раз.');
  const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(volume.iv),additionalData:aadBook},key,cipher);
  if(hex(await crypto.subtle.digest('SHA-256',raw))!==expected)throw new Error('Не удалось проверить выпуск книги.');
  return raw;
}
// v3: one stable text file per volume; each line is a deterministic AES-GCM chunk.
async function chunkPayload(key,part,expected){
  if(!/^book\/(?:v\d{2,3}|globals)\.txt$/.test(part.file)||!/^[0-9a-f]{64}$/.test(part.cipher_sha256))throw new Error('Не удалось открыть выпуск книги.');
  const response=await fetch(new URL(part.file+'?v='+part.cipher_sha256,base),{cache:'no-cache'});
  if(!response.ok)throw new Error('Книга временно недоступна. Попробуйте ещё раз позже.');
  const data=await response.arrayBuffer();
  if(hex(await crypto.subtle.digest('SHA-256',data))!==part.cipher_sha256)throw new Error('Не удалось загрузить книгу целиком. Попробуйте ещё раз.');
  const lines=decoder.decode(data).split('\n'),head=lines[0].split(' '),unique=lines.slice(2,-1);
  if(head.length!==3||head[0]!=='liellatu-chunks-1'||lines.at(-1)!==''||!/^(\d+(-\d+)?(,\d+(-\d+)?)*)?$/.test(lines[1]??'x'))throw new Error('Не удалось открыть выпуск книги.');
  const order=lines[1]?lines[1].split(',').flatMap(range=>{const [first,last=first]=range.split('-').map(Number);return Array.from({length:last-first+1},(_,i)=>first+i);}):[];
  if(order.some(i=>i>=unique.length))throw new Error('Не удалось открыть выпуск книги.');
  const fragments=await Promise.all(unique.map(async line=>{const text=atob(line),value=new Uint8Array(text.length);
    for(let i=0;i<text.length;i++)value[i]=text.charCodeAt(i);
    return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:value.subarray(0,12),additionalData:aadChunk},key,value.subarray(12)));}));
  const trailer=new Uint8Array(8),view=new DataView(trailer.buffer);
  view.setUint32(0,parseInt(head[2],16),true);view.setUint32(4,Number(head[1])%4294967296,true);
  const stream=new Blob([gzipHeader,...order.map(i=>fragments[i]),finalBlock,trailer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw=await new Response(stream).arrayBuffer();
  if(raw.byteLength!==Number(head[1])||hex(await crypto.subtle.digest('SHA-256',raw))!==expected)throw new Error('Не удалось проверить выпуск книги.');
  return raw;
}
async function bookHTML(key,volume){
  const meta=await metadata(),chunked=meta.format_version===3;
  const raw=chunked?await chunkPayload(key,volume,volume.html_sha256):await decryptPayload(key,volume,volume.html_sha256);
  if(meta.format_version===1||(chunked&&!meta.globals))return decoder.decode(raw);
  if(!globalsPromise)globalsPromise=(async()=>{
    if(chunked)return JSON.parse(decoder.decode(await chunkPayload(key,meta.globals,meta.globals.sha256)));
    const packed=await decryptPayload(key,meta.globals,meta.globals.sha256);
    const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  })().catch(error=>{globalsPromise=null;throw error;});
  const shared=await globalsPromise,refs=shared.volumes[String(volume.volume)];
  if(shared.format_version!==1||refs.reviewed_html_sha256!==volume.reviewed_html_sha256)throw new Error('Не удалось проверить выпуск книги.');
  let html=decoder.decode(raw);
  html=html.replace(/(<script type="application\/json" id="catalog">)(.*?)(<\/script>\n)/,(_,prefix,local,suffix)=>{
    const pages=local.slice('{"pages":'.length,-1);
    return prefix+shared.parts[refs.catalog].replace('%%LIELLATU_VOLUME_PAGES%%',()=>pages)+suffix;
  });
  html=html.replace('<!--liellatu-global-terms-->\n',()=>shared.parts[refs.terms]);
  if(hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(html)))!==volume.reviewed_html_sha256)throw new Error('Не удалось проверить выпуск книги.');
  return html;
}
const dialog=document.createElement('dialog');dialog.className='access-dialog';dialog.id='liellatu-login';
dialog.setAttribute('aria-labelledby','access-title');
dialog.innerHTML='<button type="button" class="access-close" aria-label="Закрыть">×</button><h2 id="access-title">Введите имя пользователя и пароль</h2><form><label for="access-username">Имя пользователя</label><input id="access-username" name="username" autocomplete="username" required autofocus><label for="access-password">Пароль</label><input id="access-password" name="password" type="password" autocomplete="current-password" required><p class="access-error" id="access-error" role="alert"></p><button type="submit" class="access-submit">Войти</button></form>';
document.body.append(dialog);
const form=dialog.querySelector('form'),errorLabel=dialog.querySelector('.access-error'),submit=dialog.querySelector('[type=submit]');
function showLogin(){errorLabel.textContent='';if(!dialog.open)dialog.showModal();}
dialog.querySelector('.access-close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>{form.password.value='';});
form.addEventListener('submit',async event=>{
  event.preventDefault();submit.disabled=true;errorLabel.textContent='';
  try{
    if(!crypto.subtle)throw new Error('Для входа откройте сайт по HTTPS.');
    const meta=await metadata(),key=await unlock(form.username.value.trim(),form.password.value,meta);
    const index=startingVolume(meta),html=await bookHTML(key,meta.volumes[index]);
    try{await cached('set',{key,keyId:meta.access.key_id});}catch{/* Login still works with browser storage disabled. */}
    activeKey=key;form.password.value='';dialog.close();
    if(isReader)showBook(html,meta,index);else location.assign(base.href);
  }catch(error){errorLabel.textContent=error.name==='OperationError'?'Не удалось открыть книгу. Введите данные ещё раз.':error.message;}
  finally{submit.disabled=false;}
});
document.querySelector('[data-liellatu-entry]')?.addEventListener('click',async event=>{
  if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();
  let entry;try{entry=await cached('get');}catch{}
  if(entry?.key)location.assign(base.href);else showLogin();
});
function showBook(html,meta,index){
  const frame=document.getElementById('book-frame');
  const nextURL=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
  frame.src=nextURL;frame.hidden=false;document.getElementById('book-opening').hidden=true;
  if(blobURL)URL.revokeObjectURL(blobURL);blobURL=nextURL;
  const choice=document.getElementById('volume-choice');choice.replaceChildren();
  for(const volume of meta.volumes){const option=document.createElement('option');option.value=String(volume.volume);option.textContent='Том '+volume.volume+' · страницы '+volume.pages[0]+'–'+volume.pages.at(-1);choice.append(option);}
  choice.value=String(meta.volumes[index].volume);document.getElementById('volume-bar').hidden=meta.volumes.length<2;document.body.classList.toggle('has-volumes',meta.volumes.length>1);
  try{localStorage.setItem('liellatu-web-volume-v1',String(meta.volumes[index].volume));}catch{}
}
if(isReader){
  (async()=>{
    try{
      const meta=await metadata();let entry;try{entry=await cached('get');}catch{}
      if(entry?.key&&entry.keyId===meta.access.key_id){
        try{const index=startingVolume(meta),html=await bookHTML(entry.key,meta.volumes[index]);activeKey=entry.key;showBook(html,meta,index);return;}
        catch(error){if(error.name!=='OperationError')throw error;try{await cached('delete');}catch{}}
      }
      document.getElementById('opening-status').textContent='Войдите, чтобы открыть книгу.';showLogin();
    }catch(error){document.getElementById('opening-status').textContent=error.message;}
  })();
  document.getElementById('volume-choice').addEventListener('change',async event=>{
    const select=event.target;select.disabled=true;
    try{const meta=await metadata(),index=meta.volumes.findIndex(v=>String(v.volume)===select.value);showBook(await bookHTML(activeKey,meta.volumes[index]),meta,index);}
    catch{document.getElementById('opening-status').textContent='Не удалось открыть том. Попробуйте ещё раз.';document.getElementById('book-opening').hidden=false;document.getElementById('book-frame').hidden=true;}
    finally{select.disabled=false;}
  });
}
