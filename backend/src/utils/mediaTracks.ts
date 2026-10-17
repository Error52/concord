// Read only bounded container metadata, never search compressed payload for magic strings.
const PREFIX_BYTES=1024*1024;
function vint(buf:Buffer,offset:number,id=false):{value:number;next:number;unknown:boolean}|null{
  const first=buf[offset];if(first===undefined||first===0)return null;
  let mask=128,length=1;while(!(first&mask)){mask>>=1;length++;}
  if(length>(id?4:8)||offset+length>buf.length)return null;
  let value=id?first:first&(mask-1),unknown=!id&&(first&(mask-1))===mask-1;
  for(let n=1;n<length;n++){value=value*256+buf[offset+n]!;unknown=unknown&&buf[offset+n]===255;}
  if(!unknown&&!Number.isSafeInteger(value))return null;
  return {value,next:offset+length,unknown};
}
export function audioOnlyWebm(input:Buffer):boolean{
  const buf=input.subarray(0,PREFIX_BYTES),types:number[]=[];let budget=4096;
  function scan(start:number,end:number,depth:number):boolean{
    if(depth>5)return false;
    for(let offset=start;offset<end;){
      if(--budget<0)return false;
      const id=vint(buf,offset,true);if(!id)return false;
      const size=vint(buf,id.next);if(!size)return false;
      const next=size.unknown?end:Math.min(end,size.next+size.value);
      if(next<=offset)return false;
      if(id.value===0x18538067||id.value===0x1654ae6b||id.value===0xae){if(!scan(size.next,next,depth+1))return false;}
      else if(id.value===0x83&&depth===3){
        if(size.unknown||size.value<1||size.value>4||size.next+size.value>buf.length)return false;
        let type=0;for(let n=size.next;n<next;n++)type=type*256+buf[n]!;types.push(type);
      }
      if(size.unknown)break;offset=size.next+size.value;
    }
    return true;
  }
  return scan(0,buf.length,0)&&types.length>0&&types.every(type=>type===2);
}
export function audioOnlyMp4(input:Buffer):boolean{
  const buf=input.subarray(0,PREFIX_BYTES),handlers:string[]=[];let budget=4096;
  function scan(start:number,end:number,depth:number):boolean{
    if(depth>5)return false;
    for(let offset=start;offset+8<=end;){
      if(--budget<0)return false;
      let size=buf.readUInt32BE(offset),header=8;
      const type=buf.toString('latin1',offset+4,offset+8);
      if(size===1){if(offset+16>end)return false;const value=buf.readBigUInt64BE(offset+8);if(value>BigInt(Number.MAX_SAFE_INTEGER))return false;size=Number(value);header=16;}
      if(size===0)size=end-offset;
      if(size<header)return false;
      const next=Math.min(end,offset+size),payload=offset+header;
      if(['moov','trak','mdia'].includes(type)){if(!scan(payload,next,depth+1))return false;}
      else if(type==='hdlr'&&depth===3){if(next-payload<12)return false;handlers.push(buf.toString('latin1',payload+8,payload+12));}
      offset+=size;
    }
    return true;
  }
  return scan(0,buf.length,0)&&handlers.length>0&&handlers.every(type=>type==='soun');
}
