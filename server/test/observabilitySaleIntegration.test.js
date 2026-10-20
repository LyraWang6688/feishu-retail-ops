'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.LARK_AGENT_APP_ID ||= 'cli_observation_test';
process.env.LARK_AGENT_APP_SECRET ||= 'observation_test_secret';
const { V1_BITABLE_SCHEMA: schema } = require('../src/config/v1BitableSchema');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const f = (t, values) => Object.fromEntries(Object.entries(values).map(([k,v]) => [schema.tables[t].fields[k],v]));

test('goods click creates master; funds click reaches details, receipts, stock and final update with distinct tap IDs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'observability-sale-'));
  const tables = {
    product: [{ record_id: 'prod', fields: f('product', { number: 'SHOE|黑色|A', itemNo: 'SHOE', category: 'A', price: 100 }) }],
    sizeManagement: [{ record_id: 'size40', fields: { ...f('sizeManagement',{ size: 40 }), 类别: ['A'] } }],
    paymentMethod: [{ record_id: 'wechat', fields: f('paymentMethod',{name:'微信'}) }],
    behavior: [ ['cash','现货','SALE_CASH'],['decrease','销售减少','STOCK_SALE_DECREASE'] ].map(([record_id,name,code]) => ({record_id,fields:f('behavior',{name,code,stockDirection:'减少',enabled:true})})),
    liveInventory: [{ record_id: 'live', fields: f('liveInventory',{product:['prod'],size:['size40'],state:'门盒',operationItemKey:'fixture:1'}) }],
  };
  const writes=[];let seq=0;
  const gateway={
    table:k=>schema.tables[k], listAll:async k=>tables[k]||[],
    get:async(k,id)=>(tables[k]||[]).find(r=>r.record_id===id)||null,
    findOneByText:async(k,key,value)=>(tables[k]||[]).find(r=>r.fields[schema.tables[k].fields[key]]===value)||null,
    create:async(k,values,options)=>{const record={record_id:`rec_${++seq}`,fields:f(k,values)};(tables[k]||=[]).push(record);writes.push({k,values,options});return{recordId:record.record_id,record};},
    update:async(k,id,values,options)=>{const record=await gateway.get(k,id);assert(record);Object.assign(record.fields,f(k,values));writes.push({k,values,options});return record;},
    delete:async(k,id,options)=>{tables[k]=(tables[k]||[]).filter(r=>r.record_id!==id);writes.push({k,delete:id,options});return{deleted:true};},
  };
  gateway.createBatch=async(k,rows,options)=>Promise.all(rows.map(row=>gateway.create(k,row,options)));
  const inventory=new InventoryService({gateway,store:new JsonTaskStore({dir:path.join(dir,'inventory'),idField:'operation_id'})});
  const write=createScanWriteService({gateway,readCache:false,sessionDir:path.join(dir,'sessions'),
    purchase:{},purchaseStore:new JsonTaskStore({dir:path.join(dir,'purchase'),idField:'task_id'}),delivery:new SalesDeliveryService({gateway,inventory})});
  try {
    const added=await write.addSaleLine({openId:'operator',productRecordId:'prod',number:'SHOE|黑色|A',itemNo:'SHOE',size:'40',amount:'100',inStock:true});
    assert.equal(added.ok,true);
    const key=(await write.sessions.get('operator')).sale.key;
    const goods=await write.submitSale({openId:'operator',submitKey:key,masterOnly:true,lineAmounts:['100']},{correlation:{tap_id:'tap-goods'}});
    assert.equal(goods.ok,true);
    assert.equal(writes.find(x=>x.k==='salesEntry').options.correlation.tap_id,'tap-goods');
    const start=writes.length;
    const paid=await write.submitSale({openId:'operator',submitKey:key,oneShot:true,lineAmounts:['100'],payments:[{method:'微信',amount:'100'}]},{correlation:{tap_id:'tap-funds'}});
    assert.equal(paid.ok,true,JSON.stringify(paid));
    for(const table of ['salesDetail','paymentRecord','inventoryLedger']) {
      const rows=writes.slice(start).filter(x=>x.k===table&&!x.delete);
      assert(rows.length>0,table);
      assert(rows.every(x=>x.options?.correlation?.tap_id==='tap-funds'),table+' must retain funds tap');
      assert(rows.every(x=>x.options.correlation.sales_entry_record_id===goods.sales_entry_record_id),table+' must retain order');
    }
    const final=writes.filter(x=>x.k==='salesEntry'&&x.values.writeStatus==='成功').at(-1);
    assert.equal(final.options.correlation.tap_id,'tap-funds');
    assert.equal(tables.liveInventory.length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
