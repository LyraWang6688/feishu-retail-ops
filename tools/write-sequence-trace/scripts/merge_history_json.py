import json, datetime
B=''
files=[
 ('销售主表','/tmp/h_salesmain.json'),
 ('销售明细','/tmp/h_salesdetail.json'),
 ('库存流水','/tmp/h_invflow.json'),
 ('S交易明细','/tmp/h_strade.json'),
]
events=[]
for tbl,fp in files:
    d=json.load(open(fp))
    for it in d['data']['items']:
        ts=it['create_time']
        t=datetime.datetime.fromtimestamp(ts).strftime('%H:%M:%S')
        fcs=it.get('field_changes')
        if not fcs:
            events.append((ts,t,tbl,it['activity_type'],it['operator'],'【新建记录】',''))
        else:
            for c in fcs:
                def fmt(v):
                    if v is None: return '空'
                    if isinstance(v,list):
                        parts=[]
                        for x in v:
                            if isinstance(x,dict): parts.append(x.get('text') or x.get('name') or x.get('id',''))
                            else: parts.append(str(x))
                        return '、'.join(parts)
                    return str(v)
                events.append((ts,t,tbl,it['activity_type'],it['operator'],c['field_name'],fmt(c.get('before'))+' → '+fmt(c.get('after'))))
events.sort(key=lambda e:(e[0],e[2]))
print(f"{'时间':>9} | {'表':<6} | {'操作人':<4} | 字段/动作 : 变化")
print('-'*100)
for ts,t,tbl,act,op,fld,chg in events:
    print(f"{t:>9} | {tbl:<6} | {op:<4} | {fld} : {chg}")
