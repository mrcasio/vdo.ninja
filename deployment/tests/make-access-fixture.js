/* Test-only fixtures. No production identifiers or credentials. AGPL-3.0. */
'use strict';
const fs = require('node:fs');
const { randomBytes, createHash, pbkdf2Sync } = require('node:crypto');
const base = 'https://test.invalid';
const password = 'fixture-only-' + randomBytes(18).toString('base64url');
const key = () => randomBytes(32).toString('hex');
const id = () => randomBytes(12).toString('hex');
const accounts = { Production: { role: 'director', rooms: ['test','staging','production'] } };
const rooms = {};
for (const name of ['test','staging','production']) {
  rooms[name] = { id: name + id(), wireId: randomBytes(8).toString('hex'), returnStream: id(), talkStream: 'ProdTalk' + id() };
  const prefix = name === 'production' ? '' : name[0].toUpperCase() + name.slice(1);
  accounts[name[0].toUpperCase() + name.slice(1) + 'Director'] = { role: 'codirector', room: name, pushStream: rooms[name].returnStream };
  for (const label of ['Host','Creator01','Creator02', ...[1,2].flatMap(c => Array.from({length:6},(_,i) => 'JokerC' + c + '_' + String(i+1).padStart(2,'0')))]) {
    accounts[prefix + label] = { role: label.startsWith('Joker') ? 'guest' : 'participant', room: name, pushStream: id(), label };
  }
  accounts[prefix + 'OBS'] = { role: 'obs', room: name };
}
function make(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const hashes = {}, keys = {}, shortlinks = {}, viewers = {};
  for (const [username, account] of Object.entries(accounts)) {
    const salt = randomBytes(16);
    hashes[username] = { salt:salt.toString('hex'), hash:pbkdf2Sync(password,salt,310000,32,'sha256').toString('hex'), iterations:310000 };
    keys[username] = key();
    const room = rooms[account.room];
    let params;
    if (['guest','participant'].includes(account.role)) {
      params = new URLSearchParams({ room:room.id,push:account.pushStream,view:'unused',label:account.label });
      params.delete('view');params.set('broadcast',room.returnStream);params.set('totalroombitrate','3000');params.set('audiogain','0');
      if (account.role==='guest') params.set('nomicbutton','');
      const token=randomBytes(24).toString('base64url');
      const query=new URLSearchParams({room:room.id,view:account.pushStream,solo:'',obstoken:token});
      viewers[token]={participant:username,path:'/?'+query+'#?turn=twilio&turnkey='+key()};
    } else if (account.role==='codirector') {
      params=new URLSearchParams({director:room.id,push:room.returnStream,noclaim:'',autogain:'0',echocancellation:'0',denoise:'0',quality:'0',maxframerate:'30',outboundvideobitrate:'3000',roombitrate:'3000',totalroombitrate:'3000'});
    }
    if (params) shortlinks[randomBytes(16).toString('base64url')]={username,path:'/?'+params+'#?'+(account.role==='codirector'?'codirector='+randomBytes(14).toString('hex')+'&':'')+'turn=twilio&turnkey='+keys[username]};
  }
  for (const room of Object.values(rooms)) {
    const params=new URLSearchParams({room:room.id,push:room.talkStream,label:'production-talk',broadcast:room.returnStream,totalroombitrate:'3000',miconly:'',audiogain:'0'});
    shortlinks[randomBytes(16).toString('base64url')]={username:'Production',path:'/?'+params+'#?turn=twilio&turnkey='+keys.Production};
  }
  const policy={version:5,wireStreamSuffix:randomBytes(3).toString('hex'),rooms,accounts};
  for (const [file,data] of Object.entries({
    'access-policy.json':policy,'auth-password-hashes.json':{version:1,accounts:hashes},'shortlinks.json':{version:1,links:shortlinks},'obs-viewers.json':{version:1,links:viewers},'turn-key-hashes.json':{version:1,keys:Object.entries(keys).map(([label,key])=>({label,sha256:createHash('sha256').update(key).digest('hex')}))},
  })) fs.writeFileSync(dir+'/'+file,JSON.stringify(data),{mode:0o600});
  return { policy,password,keys,shortlinks,viewers,base };
}
module.exports={make};
