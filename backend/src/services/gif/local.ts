import {LOCAL_GIFS} from './localCatalog.js';
import type {Gif,GifCategory,GifPage,GifProvider} from './types.js';

/** A finite, self-contained reaction library; no external key or network calls. */
export class LocalGifProvider implements GifProvider{
  readonly name='local';
  readonly mediaHosts:string[]=[];
  constructor(private readonly baseUrl:string){}
  private dto(item:typeof LOCAL_GIFS[number]):Gif{
    const url=new URL(`/api/gifs/local/${item.id}.gif`,this.baseUrl).href;
    return {id:item.id,title:item.title,width:item.width,height:item.height,url,previewUrl:url};
  }
  async search(q:string,_pos:string|null,_locale:string):Promise<GifPage>{
    const words=q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return {items:LOCAL_GIFS.filter(item=>words.every(word=>`${item.title} ${item.tags.join(' ')}`.toLowerCase().includes(word))).map(item=>this.dto(item)),next:null};
  }
  async trending(_pos:string|null,_locale:string):Promise<GifPage>{return {items:LOCAL_GIFS.map(item=>this.dto(item)),next:null};}
  async categories(locale:string):Promise<GifCategory[]>{
    return [{name:locale.startsWith('en')?'Reactions':'Реакции',query:locale.startsWith('en')?'reactions':'эмоции',previewUrl:this.dto(LOCAL_GIFS[1]).previewUrl}];
  }
  byUrl(url:string):Gif|null{return LOCAL_GIFS.map(item=>this.dto(item)).find(item=>item.url===url)??null;}
}

export function localGifBytes(filename:string):Buffer|null{
  const id=/^([a-z0-9-]+)\.gif$/.exec(filename)?.[1],item=LOCAL_GIFS.find(gif=>gif.id===id);
  return item?Buffer.from(item.data,'base64'):null;
}
