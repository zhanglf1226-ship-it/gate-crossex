from __future__ import annotations
import hashlib,hmac,json,os,sys,tempfile,time
from decimal import Decimal,InvalidOperation
from pathlib import Path
ROOT=Path(os.environ.get('GCT_LEGACY_GATE_ROOT','/opt/future/real-trading/Gate CrossEx')).resolve()
if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))
from client import CrossExClient
from config import has_credentials

def canonical(value):
 if value is None:return 'null'
 if value is True:return 'true'
 if value is False:return 'false'
 if isinstance(value,(int,float)):return json.dumps(value,separators=(',',':'))
 if isinstance(value,str):return json.dumps(value,ensure_ascii=False,separators=(',',':'))
 if isinstance(value,list):return '['+','.join(canonical(x) for x in value)+']'
 if isinstance(value,dict):return '{'+','.join(json.dumps(str(k),ensure_ascii=False)+':'+canonical(value[k]) for k in sorted(value))+'}'
 raise TypeError('unsupported snapshot value')

def normalize(raw):
 out=[]
 for item in raw:
  if not isinstance(item,dict):raise RuntimeError('positions_query_invalid')
  symbol=str(item.get('symbol') or '').strip().upper();side=str(item.get('position_side') or '').strip().upper();qty=str(item.get('position_qty') or item.get('qty') or '0').strip();venue=symbol.split('_',1)[0] if '_FUTURE_' in symbol else str(item.get('exchange_type') or '').strip().upper()
  try:amount=Decimal(qty)
  except InvalidOperation:raise RuntimeError('invalid position quantity')
  if not amount.is_finite() or amount<0:raise RuntimeError('invalid position quantity')
  if amount>0:
   if not symbol or side not in {'LONG','SHORT'} or not venue:raise RuntimeError('positions_query_unrepresentable_position')
   out.append({'symbol':symbol,'venue':venue,'side':'BUY' if side=='LONG' else 'SELL','quantity':format(amount,'f')})
 return sorted(out,key=lambda x:(x['symbol'],x['venue'],x['side'],x['quantity']))

def main():
 secret=os.environ.get('GCT_ACCOUNT_SNAPSHOT_HMAC_SECRET','');account=os.environ.get('GCT_ACCOUNT_SNAPSHOT_ACCOUNT_ID','');output=Path(os.environ.get('GCT_ACCOUNT_SNAPSHOT_FILE','/opt/future/real-trading/runtime/account_snapshot.json'))
 if len(secret)<32 or not account or not has_credentials():raise RuntimeError('snapshot exporter not configured')
 raw_positions=CrossExClient()._request('GET','/crossex/positions',params={'symbol':None,'exchange_type':None})
 if not isinstance(raw_positions,list):raise RuntimeError('positions_query_not_complete')
 positions=normalize(raw_positions)
 payload={'contract':'gate-crossex-account-snapshot/v1','accountId':account,'generatedAtMs':int(time.time()*1000),'scope':'all-crossex-futures-positions','queryComplete':True,'positionCount':len(positions),'positions':positions}
 signature=hmac.new(secret.encode(),canonical(payload).encode(),hashlib.sha256).hexdigest();document={**payload,'signatureAlgorithm':'HMAC-SHA256','signature':signature}
 output.parent.mkdir(parents=True,exist_ok=True);fd,tmp=tempfile.mkstemp(prefix=output.name+'.',dir=output.parent);os.close(fd);Path(tmp).write_text(json.dumps(document,indent=2,ensure_ascii=False)+'\n',encoding='utf-8');os.chmod(tmp,0o600);os.replace(tmp,output);print(json.dumps({'positions':len(payload['positions']),'generatedAtMs':payload['generatedAtMs']}))
if __name__=='__main__':main()
