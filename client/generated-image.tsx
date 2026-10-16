import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { openExternalUrl, useRpc, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Icon, Modal } from '@getpaseo/plugin/client/react-native';
import { readImage, type ImageCardData } from '../shared/images.js';

export function GeneratedImage({ item, theme, layout }: PluginTimelineItemProps<ImageCardData>) {
  const image=item.data, read=useRpc(readImage), reader=useRef(read);reader.current=read;
  const [uri,setUri]=useState<string|null>(null),[error,setError]=useState(''),[expanded,setExpanded]=useState(false),[retry,setRetry]=useState(0);
  const c=theme.colors;
  useEffect(()=>{
    let alive=true;setUri(null);setError('');
    if(image.status!=='available'||!image.digest)return;
    void (async()=>{
      try {
        const parts:string[]=[];let offset=0,total:number|undefined;
        for(let i=0;i<16;i++){
          const value=await reader.current({sessionId:image.sessionId,turnId:image.turnId,digest:image.digest!,offset});
          if(!alive)return;
          if(total!==undefined&&value.total!==total)throw new Error('IMAGE_CHANGED');total=value.total;
          if(value.data.length===0||offset+value.data.length>total)throw new Error('IMAGE_DATA_INVALID');
          parts.push(value.data);offset+=value.data.length;
          if(value.nextOffset===null){if(offset!==total)throw new Error('IMAGE_INCOMPLETE');setUri('data:image/webp;base64,'+parts.join(''));return;}
          if(value.nextOffset!==offset)throw new Error('IMAGE_OFFSET_INVALID');
        }
        throw new Error('IMAGE_TOO_LARGE');
      }catch{if(alive)setError('预览暂时无法读取。重试只读取已保存的图片，不会重新生成。');}
    })();
    return()=>{alive=false};
  },[image.digest,image.sessionId,image.turnId,image.status,retry]);
  const aspect=(image.previewWidth??image.width??1)/(image.previewHeight??image.height??1);
  const button=(title:string,fn:()=>void,icon:string)=><Pressable accessibilityRole="button" onPress={fn} style={({pressed})=>({minHeight:44,paddingHorizontal:14,paddingVertical:10,borderRadius:10,backgroundColor:c.surface2,opacity:pressed ? 0.7 : 1,flexDirection:'row',alignItems:'center',gap:8})}><Icon name={icon} size={16} color={c.foreground}/><Text style={{color:c.foreground,fontSize:13,fontWeight:'600'}}>{title}</Text></Pressable>;
  const original=()=>{void openExternalUrl('https://chatgpt.com/c/'+image.conversationId).catch(()=>setError('网页未能打开，请在浏览器中查看原对话。'));};
  return <View style={{width:'100%',maxWidth:600,borderWidth:1,borderColor:c.border,borderRadius:16,backgroundColor:c.surface1,overflow:'hidden',marginVertical:8}}>
    <View style={{padding:16,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}}>
      <View style={{flexDirection:'row',alignItems:'center',gap:10}}><Icon name="Image" size={18} color={c.foreground}/><Text style={{color:c.foreground,fontSize:15,fontWeight:'600'}}>图片已生成</Text></View>
      <Text style={{color:c.foregroundMuted,fontSize:12}}>{image.width&&image.height?`${image.width} × ${image.height}`:'ChatGPT'}</Text>
    </View>
    {uri?<Pressable accessibilityRole="button" accessibilityLabel="放大图片预览" onPress={()=>setExpanded(true)}><Image accessibilityLabel="ChatGPT 生成的图片预览" source={{uri}} resizeMode="contain" style={{width:'100%',aspectRatio:Math.max(.35,Math.min(3,aspect)),maxHeight:layout.compact?380:500,backgroundColor:c.surface0}} onError={()=>setError('预览格式无法显示，请到网页查看原图。')}/></Pressable>:<View style={{minHeight:160,alignItems:'center',justifyContent:'center',gap:10,padding:24,backgroundColor:c.surface0}}><Icon name={error||image.status==='unavailable'?'ImageOff':'Image'} size={28} color={c.foregroundMuted}/><Text style={{color:c.foregroundMuted,textAlign:'center'}}>{image.status==='unavailable'?'图片已在网页生成，预览未能读取。':error?'预览加载失败':'正在读取已保存的预览…'}</Text></View>}
    <View style={{padding:16,gap:12}}>
      <Text style={{color:c.foregroundMuted,fontSize:12,lineHeight:18}}>此处为压缩预览，最长边 1600 像素；原图在 ChatGPT 网页保留。</Text>
      {!!error&&<Text accessibilityRole="alert" style={{color:c.statusWarning,fontSize:13,lineHeight:19}}>{error}</Text>}
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{uri&&button('放大预览',()=>setExpanded(true),'Maximize2')}{!!error&&image.status==='available'&&button('重试读取',()=>setRetry(n=>n+1),'RefreshCw')}{button('网页查看原图',original,'ExternalLink')}</View>
    </View>
    <Modal title="图片预览" open={expanded} onOpenChange={setExpanded}><Modal.Content>{uri&&<Image source={{uri}} resizeMode="contain" style={{width:'100%',aspectRatio:aspect,minHeight:200,maxHeight:720}}/>}<Text style={{color:c.foregroundMuted}}>压缩预览 · 原图请在网页查看</Text>{button('网页查看原图',original,'ExternalLink')}</Modal.Content></Modal>
  </View>;
}
