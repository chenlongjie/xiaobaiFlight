// 极简静态服务器：node serve.mjs [port]
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';

const port=parseInt(process.argv[2]||'8714');
const root=process.cwd();
const MIME={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.mjs':'text/javascript;charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.css':'text/css'};

createServer(async(req,res)=>{
  try{
    let p=decodeURIComponent(req.url.split('?')[0]);
    if(p==='/')p='/index.html';
    const file=join(root,normalize(p).replace(/^(\.\.[/\\])+/,''));
    const buf=await readFile(file);
    res.writeHead(200,{'content-type':MIME[extname(file)]||'application/octet-stream','cache-control':'no-store'});
    res.end(buf);
  }catch(e){
    res.writeHead(404,{'content-type':'text/plain'});res.end('404 '+req.url);
  }
}).listen(port,()=>console.log(`http://127.0.0.1:${port}/`));
