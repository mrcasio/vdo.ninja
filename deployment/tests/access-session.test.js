/* Receiver-side media revocation and local reconnect stop. Test data only. AGPL-3.0. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
class Socket {
  constructor(url){this.url=url;this.events=new Map();}
  addEventListener(type,fn){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push(fn);}
  emit(type,event){let stopped=false;event.stopImmediatePropagation=()=>stopped=true;for(const fn of this.events.get(type)||[]){fn(event);if(stopped)break;}return stopped;}
}
const calls=[];let trackStopped=false,overlay=false;
const element={srcObject:{getTracks:()=>[{stop:()=>trackStopped=true}]}};
const session={closeRPC:(...args)=>calls.push(['rpc',...args]),closePC:(...args)=>calls.push(['pc',...args]),hangup:()=>calls.push(['hangup'])};
const doc={addEventListener(){},querySelectorAll:()=>[element],getElementById:()=>overlay?{}:null,createElement:()=>({style:{},append(){},addEventListener(){}}),documentElement:{append(){overlay=true;}}};
const window={WebSocket:Socket};
const context=vm.createContext({window,document:doc,session,URL,DOMException,location:{href:'https://fixture.invalid/?room=test',host:'fixture.invalid',reload(){}},setTimeout(){},fetch(){throw Error('Unexpected network');}});
const source=[path.resolve(__dirname,'../overrides/access-session.js'),path.resolve(__dirname,'../../access-session.js')].find(fs.existsSync);
vm.runInContext(fs.readFileSync(source,'utf8'),context);
const socket=new window.WebSocket('wss://fixture.invalid/ws');
assert.equal(socket.emit('message',{data:JSON.stringify({request:'easycubePeerRevoked',UUID:'old-fixture-peer'})}),true);
assert.equal(calls.filter(x=>x[0]==='rpc'&&x[1]==='old-fixture-peer').length,1);assert.equal(calls.filter(x=>x[0]==='pc'&&x[1]==='old-fixture-peer').length,1);
assert.equal(socket.emit('message',{data:JSON.stringify({UUID:'old-fixture-peer',bye:true})}),true);
assert.equal(socket.emit('message',{data:JSON.stringify({UUID:'peer',bye:true})}),false);
socket.emit('message',{data:JSON.stringify({request:'easycubeAccessRevoked',reason:'session-replaced'})});
assert.ok(calls.some(x=>x[0]==='hangup'));assert.ok(trackStopped);assert.ok(overlay);
assert.throws(()=>new window.WebSocket('wss://fixture.invalid/ws'),/Session ended/);
assert.doesNotThrow(()=>new window.WebSocket('wss://unrelated.invalid/stream'));
console.log('PASS: browser helper closes revoked peer media and local tracks, blocks stale automatic reconnects, preserves normal protocol messages.');
