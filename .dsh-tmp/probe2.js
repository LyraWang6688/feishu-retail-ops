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
 const t=process.env.FEISHU_V1_BITABLE_APP_TOKEN, tid='tblLjFe3NjU61xKB';
 let pt,recs=[];
 do{const r=await c.bitable.appTableRecord.list({path:{app_token:t,table_id:tid},params:{page_size:200,page_token:pt}});
    recs.push(...(r.data?.items||[])); pt=r.data?.has_more?r.data?.page_token:undefined;}while(pt);
 for(const n of ['解析状态','确认状态','销售状态','资金状态','库存状态','收款状态']){
   const d={}; recs.forEach(r=>{const k=flat(r.fields?.[n])||'(空)';d[k]=(d[k]||0)+1;});
   console.log(n, JSON.stringify(d));
 }
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
