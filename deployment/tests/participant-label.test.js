/* Central labels use VDO's own metadata update and preserve media/URLs. AGPL-3.0. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
async function testParticipantLabel() {
  const calls=[],timers=[];let label='Creator01: Beispielname';let fail=false;
  const document={getElementById:()=>null,title:''};const window={};
  const context=vm.createContext({window,document,AbortController,sanitizeLabel:value=>value,
    fetch:async()=>{if(fail)throw Error('offline');return{ok:true,json:async()=>({mediaLabel:label})};},
    setTimeout:(fn,delay)=>{if(delay===10000)timers.push(fn);return delay;},clearTimeout(){} });
  const source=[path.resolve(__dirname,'../overrides/participant-label.js'),path.resolve(__dirname,'../../participant-label.js')].find(fs.existsSync);
  vm.runInContext(fs.readFileSync(source,'utf8'),context);
  const active={label:'Old URL label',sendMessage:data=>calls.push(JSON.parse(JSON.stringify(data)))};
  await window.easycubeParticipantLabel.start(active);assert.equal(active.label,label);assert.equal(calls.length,0);
  label='Creator01: Neuer Name';await timers.shift()();assert.deepEqual(calls,[{changeLabel:true,value:label}]);
  fail=true;await timers.shift()();assert.equal(active.label,label);assert.equal(calls.length,1);
  console.log('PASS: initial participant label precedes publishing; updates use native changeLabel metadata; service outages preserve media and label.');
}
module.exports={testParticipantLabel};
