/* Isolated integration checks, AGPL-3.0. No production endpoints or credentials. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { make } = require('./make-access-fixture');
require('./access-session.test');
const { CredentialStore } = require('../turn-broker/access-manager');
const root = path.resolve(__dirname,'..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'access-security-'));
const fixture = make(tmp+'/secrets');
fs.mkdirSync(tmp+'/state');
const origin=fixture.base;
const brokerPort=11880, signalingPort=11881;
const brokerURL='http://127.0.0.1:'+brokerPort;
let broker, signaling;
const peers=[];
function processServer(file,env){
  const child=spawn(process.execPath,[file],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);child.logs=()=>logs;return child;
}
const env={PORT:String(brokerPort),ALLOWED_ORIGIN:origin,ACCESS_POLICY:tmp+'/secrets/access-policy.json',PASSWORD_HASHES:tmp+'/secrets/auth-password-hashes.json',SHORTLINKS_FILE:tmp+'/secrets/shortlinks.json',OBS_VIEWERS_FILE:tmp+'/secrets/obs-viewers.json',TURN_KEY_HASHES:tmp+'/secrets/turn-key-hashes.json',SESSION_FILE:tmp+'/state/sessions.json',LOGIN_PAGE:root+'/turn-broker/login.html',ADMIN_PAGE:root+'/turn-broker/production-access.html',HOME_PAGE:root+'/turn-broker/home.html'};
async function ready(url){for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server startup failed');}
async function api(url,{cookie,method='GET',body,headers={}}={}){
  return fetch(brokerURL+url,{method,redirect:'manual',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...headers},...(body!==undefined?{body}:{} )});
}
async function login(username,password=fixture.password){
  const r=await api('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-VDO-Action':'login','X-Real-IP':'fixture-'+username},body:new URLSearchParams({username,password}).toString()});
  assert.equal(r.status,204,'login '+username);return r.headers.get('set-cookie').split(';')[0];
}
async function identity(cookie){
  const r=await api('/internal/authenticate',{cookie,headers:{'X-Original-URI':'/ws'}});
  return {status:r.status,username:r.headers.get('x-authenticated-user'),hash:r.headers.get('x-authenticated-session')};
}
async function connect(username,cookie){
  const id=await identity(cookie);assert.equal(id.status,204);
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://127.0.0.1:'+signalingPort+'/ws',{headers:{Origin:origin,'X-Authenticated-User':username,'X-Authenticated-Session':id.hash}});
    const messages=[];ws.on('message',b=>messages.push(JSON.parse(b.toString())));ws.once('error',reject);ws.once('open',()=>{
      const peer={ws,messages,send:x=>ws.send(JSON.stringify(x)),until:async predicate=>{for(let i=0;i<80;i++){const index=messages.findIndex(predicate);if(index>=0)return messages.splice(index,1)[0];await new Promise(r=>setTimeout(r,50));}throw Error('Missing signaling response');}};
      peers.push(peer);resolve(peer);
    });
  });
}
async function closed(peer){if(peer.ws.readyState===WebSocket.CLOSED)return;await Promise.race([new Promise(r=>peer.ws.once('close',r)),new Promise((_,reject)=>setTimeout(()=>reject(Error('Connection not revoked')),4500))]);}
async function rotate(cookie,usernames){return api('/api/production-access/rotate',{cookie,method:'POST',headers:{'Content-Type':'application/json','X-VDO-Action':'rotate-production-access'},body:JSON.stringify({usernames,confirm:'ROTATE_PRODUCTION'})});}
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
(async()=>{
  broker=processServer(root+'/turn-broker/server.js',env);await ready(brokerURL+'/health');
  signaling=processServer(root+'/signaling/vdoninja_advanced.js',{PORT:String(signalingPort),ALLOWED_ORIGIN:origin,ACCESS_POLICY:env.ACCESS_POLICY,AUTH_BROKER_URL:brokerURL});await ready('http://127.0.0.1:'+signalingPort+'/');
  const welcome=await api('/home');assert.equal(welcome.status,200);assert.ok((await welcome.text()).includes('loginForm'));
  assert.equal((await api('/api/navigation')).status,401);
  for(const [username,account] of Object.entries(fixture.policy.accounts)) {
    if(username==='Production') continue;
    const ownCookie=await login(username);
    const ownHome=await api('/home',{cookie:ownCookie});
    const nav=await (await api('/api/navigation',{cookie:ownCookie})).json();
    assert.equal(nav.username,username);
    if(account.role==='obs') {
      assert.equal(ownHome.status,200);assert.equal(nav.sections.length,1);assert.equal(nav.sections[0].links.length,15);
      for(const item of nav.sections[0].links) {const token=item.href.slice('/obs/'.length);assert.equal(fixture.policy.accounts[fixture.viewers[token].participant].room,account.room);}
    } else {
      assert.equal(ownHome.status,302);const target=ownHome.headers.get('location');assert.equal(fixture.shortlinks[target.slice('/l/'.length)].username,username);assert.equal(nav.default,target);
    }
    assert.equal((await api('/launch/director/production',{cookie:ownCookie})).status,403);
  }
  const production=await login('Production');const production2=await login('Production');
  const productionHome=await api('/home',{cookie:production});assert.equal(productionHome.status,200);assert.ok((await productionHome.text()).includes('api/navigation'));
  const portal=await (await api('/api/navigation',{cookie:production})).json();assert.equal(portal.sections.length,4);assert.equal(portal.default,'/home');
  for(const name of ['test','staging','production']) {
    const launch=await api('/launch/director/'+name,{cookie:production});assert.equal(launch.status,302);
    const target=new URL(launch.headers.get('location'),origin);assert.equal(target.searchParams.get('director'),fixture.policy.rooms[name].id);assert.equal(target.searchParams.get('nopush'),'');
    const fragment=new URLSearchParams(target.hash.replace(/^#\??/,''));assert.equal(fragment.get('turnkey'),fixture.keys.Production);assert.equal(fragment.get('codirector').length,28);
    const authorized=await api('/internal/authorize-entry',{headers:{'X-Authenticated-User':'Production','X-Original-URI':launch.headers.get('location')}});assert.equal(authorized.status,204);
  }
  assert.equal((await api('/api/navigation?username=Production')).status,404);

  assert.equal((await identity(production)).status,204,'Production retains multiple sessions');
  const admin=await api('/api/production-access',{cookie:production});assert.equal(admin.status,200);const list=await admin.json();assert.equal(list.accounts.length,14);assert.ok(!list.accounts.some(x=>['Host','Production'].includes(x.username)));
  const guestCookie=await login('JokerC1_01');const guest=await connect('JokerC1_01',guestCookie);
  const creatorCookie=await login('Creator01');const creator=await connect('Creator01',creatorCookie);
  const stagingCookie=await login('StagingJokerC1_01');const staging=await connect('StagingJokerC1_01',stagingCookie);
  const director=await connect('Production',production);const director2=await connect('Production',production2);
  const room=fixture.policy.rooms.production;
  director.send({request:'joinroom',roomid:room.wireId,claim:true});await director.until(x=>x.request==='listing');
  guest.send({request:'seed',streamID:fixture.policy.accounts.JokerC1_01.pushStream+fixture.policy.wireStreamSuffix});guest.send({request:'joinroom',roomid:room.wireId});await guest.until(x=>x.request==='listing');
  creator.send({request:'seed',streamID:fixture.policy.accounts.Creator01.pushStream+fixture.policy.wireStreamSuffix});creator.send({request:'joinroom',roomid:room.wireId});await creator.until(x=>x.request==='listing');
  for(let i=0;i<5;i++) guest.send({request:'play',streamID:fixture.policy.accounts.Creator01.pushStream+fixture.policy.wireStreamSuffix});
  await creator.until(x=>x.request==='offerSDP');await new Promise(r=>setTimeout(r,100));assert.equal(creator.messages.filter(x=>x.request==='offerSDP').length,0,'duplicate play requests are coalesced');
  director.send({request:'play',streamID:'unconfigured-fixture-source'});await director.until(x=>x.request==='alert');
  const newCookie=await login('JokerC1_01');assert.equal((await identity(guestCookie)).status,401,'old login cannot reconnect');
  const replacement=await connect('JokerC1_01',newCookie);await closed(guest);await director.until(x=>x.request==='easycubePeerRevoked');
  assert.equal(creator.ws.readyState,WebSocket.OPEN);assert.equal(director.ws.readyState,WebSocket.OPEN);
  // Reload or another tab with the same current login replaces the connection.
  const reloaded=await connect('JokerC1_01',newCookie);await closed(replacement);assert.equal(reloaded.ws.readyState,WebSocket.OPEN);
  // Entry authorization and OBS capabilities stay intact.
  for(const [token,entry] of Object.entries(fixture.shortlinks)){
    const r=await api('/l/'+token);assert.equal(r.status,302);assert.equal(r.headers.get('location'),entry.path);
  }
  for(const [token,entry] of Object.entries(fixture.viewers)) {const r=await api('/obs/'+token);assert.equal(r.status,302);assert.equal(r.headers.get('location'),entry.path);}
  assert.equal((await api('/api/production-access',{cookie:newCookie})).status,403);
  assert.equal((await api('/api/production-access',{headers:{'X-Authenticated-User':'Production'}})).status,403,'identity header alone cannot administer');
  for(const user of ['Host','Production','StagingCreator01','TestJokerC1_01','ProductionDirector']) assert.equal((await rotate(production,[user])).status,400,'protected '+user);
  assert.equal((await api('/api/production-access/rotate',{cookie:production,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usernames:['Creator01'],confirm:'ROTATE_PRODUCTION'})})).status,403,'action header required');
  const changed=await rotate(production,['JokerC1_01','Creator01']);assert.equal(changed.status,200);const changedData=await changed.json();assert.equal(changedData.credentials.length,2);
  await closed(reloaded);await closed(creator);
  assert.equal((await identity(newCookie)).status,401);assert.equal((await identity(creatorCookie)).status,401);
  assert.equal(staging.ws.readyState,WebSocket.OPEN);assert.equal(director.ws.readyState,WebSocket.OPEN);assert.equal(director2.ws.readyState,WebSocket.OPEN);
  const overrideText=fs.readFileSync(tmp+'/state/credentials.json','utf8');
  for(const item of changedData.credentials) assert.ok(!overrideText.includes(item.password),'plaintext passwords must not persist');
  const newGuestPassword=changedData.credentials.find(x=>x.username==='JokerC1_01').password;
  const latestGuestCookie=await login('JokerC1_01',newGuestPassword);
  const oldPasswordResult=await api('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-VDO-Action':'login','X-Real-IP':'old-password-test'},body:new URLSearchParams({username:'JokerC1_01',password:fixture.password}).toString()});
  assert.equal(oldPasswordResult.status,401);
  const noisy=await connect('JokerC1_01',latestGuestCookie);
  for(let i=0;i<800;i++) if(noisy.ws.readyState===WebSocket.OPEN) noisy.send({padding:i});
  await closed(noisy);assert.equal(director.ws.readyState,WebSocket.OPEN);assert.equal(staging.ws.readyState,WebSocket.OPEN);
  const allNames=list.accounts.map(x=>x.username);const allChanged=await rotate(production,allNames);assert.equal(allChanged.status,200);assert.equal((await allChanged.json()).credentials.length,14);
  const overrides=JSON.parse(fs.readFileSync(tmp+'/state/credentials.json'));assert.deepEqual(Object.keys(overrides.accounts).sort(),allNames.sort());
  const hostCookie=await login('Host');const host=await connect('Host',hostCookie);
  const logout=await api('/logout',{cookie:hostCookie,method:'POST',headers:{'X-VDO-Action':'logout'}});assert.equal(logout.status,204);await closed(host);assert.equal((await identity(hostCookie)).status,401);
  // Restarting the broker must retain overrides and revoke an expired cookie.
  const finalCreds=await (await rotate(production,['Creator02'])).json();
  const expireCookie=await login('Creator02',finalCreds.credentials[0].password);const expiring=await connect('Creator02',expireCookie);
  const sessionFile=tmp+'/state/sessions.json';const persisted=JSON.parse(fs.readFileSync(sessionFile));
  for(const value of Object.values(persisted)) if(value.username==='Creator02') value.expires=Date.now()-1;
  fs.writeFileSync(sessionFile,JSON.stringify(persisted));await stop(broker);broker=processServer(root+'/turn-broker/server.js',env);await ready(brokerURL+'/health');await closed(expiring);
  assert.equal((await identity(expireCookie)).status,401);assert.equal((await identity(production)).status,204);assert.equal((await identity(stagingCookie)).status,204);
  assert.equal(director.ws.readyState,WebSocket.OPEN);assert.equal(staging.ws.readyState,WebSocket.OPEN);
  const invalidAfterRestart=await api('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-VDO-Action':'login','X-Real-IP':'restart-test'},body:new URLSearchParams({username:'Creator02',password:fixture.password}).toString()});assert.equal(invalidAfterRestart.status,401);
  console.log('PASS: all 52 scoped home routes; Production portal/Director launch authorization; latest login wins; old connections and receiver peers revoked; reload takeover; Production multitab; all 96 links; admin role and CSRF; protected accounts; 14-account rotation; hash-only storage; logout/expiry; durable overrides; flood isolation.');
})().catch(async error=>{console.error(error.stack);if(broker)console.error(broker.logs());if(signaling)console.error(signaling.logs());process.exitCode=1;}).finally(async()=>{peers.forEach(p=>p.ws.terminate());await stop(signaling);await stop(broker);fs.rmSync(tmp,{recursive:true,force:true});});
