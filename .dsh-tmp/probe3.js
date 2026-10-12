const path=require('node:path'),fs=require('node:fs');
const S='/opt/box2bitable/server';
const e=[path.join(S,'.env'),path.join(S,'..','.env')].find(p=>fs.existsSync(p));
require(path.join(S,'node_modules/dotenv')).config({path:e,quiet:true});
const lark=require(path.join(S,'node_modules/@larksuiteoapi/node-sdk'));
const {getLarkAgentCredentials}=require(path.join(S,'src/config/larkAgent'));
const flat=(v)=>v==null?'':Array.isArray(v)?v.map(flat).filter(Boolean).join(','):typeof v==='object'?String(v.text??v.name??v.value??''):String(v);
(async()=>{
 const {appId,appSecret}=getLarkAgentCredentials();
 const c=new lark.Client({appId,appSecret,logger:{error(){},warn(){},info(){},debug(){},trace(){}}});
 const t=process.env.FEISHU_V1_BITABLE_APP_TOKEN;
 const fetchAll=async(tid)=>{let pt,out=[];do{const r=await c.bitable.appTableRecord.list({path:{app_token:t,table_id:tid},params:{page_size:200,page_token:pt}});out.push(...(r.data?.items||[]));pt=r.data?.has_more?r.data?.page_token:undefined;}while(pt);return out;};
 const entries=await fetchAll('tblLjFe3NjU61xKB');
 const details=await fetchAll('tblxW5WMKDULyolA');
 const payments=await fetchAll('tblTpLOtTLhWxXvm');
 const dt=details.filter(d=>flat(d.fields?.['销售单号']).length>0).length;
 console.log('明细总数',details.length,'其中带销售单号',dt);
 console.log('收款明细总数',payments.length,'带关联销售单',payments.filter(p=>flat(p.fields?.['关联销售单'])).length);
 // 可按"是否有明细/收款行"重算 已入账 的单数
 const detailByOrder=new Set(), payByOrder=new Set();
 details.forEach(d=>String(flat(d.fields?.['销售单号'])).split(',').forEach(x=>x&&detailByOrder.add(x)));
 payments.forEach(p=>String(flat(p.fields?.['关联销售单'])).split(',').forEach(x=>x&&payByOrder.add(x)));
 console.log('主表记录数', entries.length);
 console.log('有明细的主表记录(按单号)', [...detailByOrder].length, ' 有收款行的', [...payByOrder].length);
 const withFail=entries.filter(e=>flat(e.fields?.['失败原因'])).length;
 console.log('失败原因非空的记录数', withFail);
 const cancelLike=entries.filter(e=>/取消/.test(flat(e.fields?.['失败原因']))).length;
 console.log('失败原因里含"取消"的', cancelLike);
 // 收款状态公式仍可用
 const d={};entries.forEach(e=>{const k=flat(e.fields?.['收款状态'])||'(空)';d[k]=(d[k]||0)+1;});
 console.log('主表 收款状态(公式,未被清)',JSON.stringify(d));
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
