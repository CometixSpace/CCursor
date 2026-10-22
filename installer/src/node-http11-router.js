/**
 * Shared process-local HTTP/1.1 whitelist router.
 *
 * Cursor's legacy always-local extension and the newer Agent Host run in
 * independent Extension Host processes. Node built-in monkey patches cannot
 * cross that boundary, so each active entry point must prepend this payload
 * before webpack initializes its ConnectRPC transport modules.
 */
import {
  CCURSOR_DIR_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ROUTES_FILE_NAME,
} from './defaults.js';

export const HTTP11_ROUTER_VERSION_MARKER = '__byokHttp11RouterV3';
export const HTTP11_ROUTER_SOURCE_MARKER = 'BYOK-HTTP11-ROUTER-V3';

/**
 * @param {{ guardMarker: string, processLabel: string }} options
 */
export function buildNodeHttp11RouterPayload({ guardMarker, processLabel }) {
  const fallbackHost = JSON.stringify(DEFAULT_HOST);
  const fallbackPort = String(DEFAULT_PORT);
  const ccursorDir = JSON.stringify(CCURSOR_DIR_NAME);
  const routesFile = JSON.stringify(ROUTES_FILE_NAME);
  const guard = JSON.stringify(guardMarker);
  const label = JSON.stringify(processLabel);
  const versionMarker = JSON.stringify(HTTP11_ROUTER_VERSION_MARKER);

  return `/* ${HTTP11_ROUTER_SOURCE_MARKER} */
(function(){
  var VERSION_MARKER=${versionMarker},GUARD_MARKER=${guard},PROCESS_LABEL=${label};
  if(globalThis[VERSION_MARKER]){globalThis[GUARD_MARKER]=true;return;}
  globalThis[VERSION_MARKER]=true;globalThis[GUARD_MARKER]=true;
  var _http=require("http"),_https=require("https"),_fs=require("fs"),_path=require("path"),_os=require("os"),_module=require("module");
  var _proxyHttpRequest=_http.request,_proxyHttpsRequest=_https.request;
  var _proxyHttpGet=_http.get,_proxyHttpsGet=_https.get;
  var _directHttpOwner=_http.__vscodeOriginal||_http;
  var _directHttpRequest=(_http.__vscodeOriginal&&_http.__vscodeOriginal.request)||_proxyHttpRequest;
  var ROUTES_PATH=_path.join(_os.homedir(),${ccursorDir},${routesFile});
  var LOG_DIR=_path.join(_os.homedir(),${ccursorDir},"logs");
  var LOG_PATH=_path.join(LOG_DIR,"router-"+PROCESS_LABEL+"-"+process.pid+".log");
  function routerLog(event,extra){try{_fs.mkdirSync(LOG_DIR,{recursive:true});_fs.appendFileSync(LOG_PATH,new Date().toISOString()+" ["+PROCESS_LABEL+"] "+event+(extra?" "+JSON.stringify(extra):"")+"\\n");}catch(e){}}
  routerLog("payload loaded",{pid:process.pid,argv:process.argv.slice(0,2).join(" "),title:String(process.env.VSCODE_PROCESS_TITLE||"")});
  var FALLBACK_HOST=${fallbackHost},FALLBACK_PORT=${fallbackPort};
  var _title=String(process.env.VSCODE_PROCESS_TITLE||""),_widMatch=_title.match(/\\[(\\d+)-\\d+\\]/),WINDOW_ID=_widMatch?_widMatch[1]:null;
  var state={host:FALLBACK_HOST,port:FALLBACK_PORT,base:"http://"+FALLBACK_HOST+":"+FALLBACK_PORT,svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};
  function baseUrl(host,port){var h=String(host);if(h.indexOf(":")!==-1&&h.charAt(0)!=="[")h="["+h+"]";return"http://"+h+":"+port;}
  function emptyState(){return{host:FALLBACK_HOST,port:FALLBACK_PORT,base:baseUrl(FALLBACK_HOST,FALLBACK_PORT),svcSet:new Set(),methodSet:new Set(),restSet:new Set(),ruleCount:0,restCount:0};}
  function loadConfig(){try{
    var cfg=JSON.parse(_fs.readFileSync(ROUTES_PATH,"utf-8"));
    var host=cfg&&cfg.server&&typeof cfg.server.host==="string"&&cfg.server.host.trim()?cfg.server.host.trim():FALLBACK_HOST;
    var rawPort=cfg&&cfg.server&&cfg.server.port;
    var port=(typeof rawPort==="number"||typeof rawPort==="string")&&String(rawPort).trim()?rawPort:FALLBACK_PORT;
    var rules=cfg&&Array.isArray(cfg.redirect)?cfg.redirect:[];
    var svcSet=new Set(),methodSet=new Set(),restSet=new Set(),ruleCount=0,restCount=0;
    for(var i=0;i<rules.length;i++){var rule=rules[i];if(typeof rule!=="string")continue;
      if(rule.indexOf("REST:")===0){restSet.add(rule.slice(5));restCount++;}
      else if(rule.indexOf("/")!==-1){methodSet.add(rule);ruleCount++;}
      else{svcSet.add(rule);ruleCount++;}}
    return{host:host,port:port,base:baseUrl(host,port),svcSet:svcSet,methodSet:methodSet,restSet:restSet,ruleCount:ruleCount,restCount:restCount};
  }catch(e){return emptyState();}}
  function applyState(event){state=loadConfig();console.log("[BYOK] "+PROCESS_LABEL+" "+event+" -> "+state.base+" (ConnectRPC="+state.ruleCount+", REST="+state.restCount+")");}
  applyState("routes loaded");
  try{_fs.watchFile(ROUTES_PATH,{interval:2000,persistent:false},function(){applyState("routes reloaded");});}catch(e){console.warn("[BYOK] "+PROCESS_LABEL+" watchFile failed: "+e.message);}
  function normalizeHost(host){return String(host||"").trim().replace(/^\\[|\\]$/g,"").toLowerCase();}
  function isCursorApiHost(host){host=normalizeHost(host);return/(^|\\.)api[234]\\.cursor\\.sh$|(^|\\.)api5\\.cursor\\.sh$|(^|\\.)gcpp\\.cursor\\.sh$|^api\\.playground\\.cursor\\.sh$/.test(host);}
  function pathOnly(pathname){pathname=String(pathname||"");var hash=pathname.indexOf("#");if(hash!==-1)pathname=pathname.slice(0,hash);var query=pathname.indexOf("?");return query===-1?pathname:pathname.slice(0,query);}
  function shouldRedirect(pathname){pathname=pathOnly(pathname);if(!pathname||pathname.length<2)return false;if(state.restSet.has(pathname))return true;var path=pathname.charAt(0)==="/"?pathname.slice(1):pathname;var slash=path.indexOf("/");if(slash===-1)return false;if(state.methodSet.has(path))return true;return state.svcSet.has(path.slice(0,slash));}
  function parseRequest(input){try{
    if(typeof input==="string"){var s=new URL(input);return{hostname:s.hostname,port:s.port,protocol:s.protocol,path:s.pathname+s.search,raw:input,kind:"string"};}
    if(input instanceof URL)return{hostname:input.hostname,port:input.port,protocol:input.protocol,path:input.pathname+input.search,raw:input,kind:"url"};
    if(input&&typeof input==="object"){var hostText=String(input.hostname||input.host||""),port=input.port||"";
      if(!input.hostname&&hostText.charAt(0)!=="["){var colon=hostText.lastIndexOf(":");if(colon>0&&/^\\d+$/.test(hostText.slice(colon+1))){if(!port)port=hostText.slice(colon+1);hostText=hostText.slice(0,colon);}}
      return{hostname:hostText,port:String(port||""),protocol:input.protocol||"",path:input.path||((input.pathname||"/")+(input.search||"")),raw:input,kind:"object"};}
  }catch(e){}return null;}
  function isConfiguredLocal(parsed){if(!parsed||(parsed.protocol&&parsed.protocol!=="http:"))return false;if(normalizeHost(parsed.hostname)!==normalizeHost(state.host))return false;return!parsed.port||String(parsed.port)===String(state.port);}
  function cloneHeaders(headers){var result={};if(!headers)return result;try{if(typeof Headers!=="undefined"&&headers instanceof Headers){headers.forEach(function(value,key){result[key]=value;});return result;}}catch(e){}
    if(Array.isArray(headers)){if(headers.length&&Array.isArray(headers[0])){for(var i=0;i<headers.length;i++)if(headers[i]&&headers[i].length>=2)result[String(headers[i][0])]=headers[i][1];}else{for(var j=0;j+1<headers.length;j+=2)result[String(headers[j])]=headers[j+1];}return result;}
    if(typeof headers==="object")for(var key in headers)if(Object.prototype.hasOwnProperty.call(headers,key))result[key]=headers[key];return result;}
  function routeHeaders(headers){var result=cloneHeaders(headers),hasWid=false;for(var key in result){var lower=key.toLowerCase();if(lower==="host"||lower===":authority")delete result[key];else if(lower==="x-client-wid")hasWid=true;}if(WINDOW_ID&&!hasWid)result["x-client-wid"]=WINDOW_ID;result["x-byok-route-source"]=PROCESS_LABEL;return result;}
  function localOptions(options){var result=Object.assign({},options||{});result.headers=routeHeaders(result.headers);result.agent=false;delete result.host;delete result.servername;delete result.createConnection;delete result.ALPNProtocols;return result;}
  function rewriteOptions(options){var result=localOptions(options);result.protocol="http:";result.hostname=state.host;result.port=state.port;return result;}
  function rewriteUrl(parsed){var path=parsed.path||"/";return state.base+(path.charAt(0)==="/"?path:"/"+path);}
  function directRequest(parsed,second,callback){var cb=typeof second==="function"?second:callback;if(parsed.kind==="object")return _directHttpRequest.call(_directHttpOwner,rewriteOptions(parsed.raw),cb);var options=typeof second==="function"||second==null?{}:second;return _directHttpRequest.call(_directHttpOwner,rewriteUrl(parsed),localOptions(options),cb);}
  function interceptRequest(isHttps){return function(input,options,callback){var parsed=parseRequest(input);if(!parsed)routerLog("unparsed-request",{https:!!isHttps,inputType:typeof input});else if(isCursorApiHost(parsed.hostname))routerLog("request",{https:!!isHttps,host:parsed.hostname,path:parsed.path,kind:parsed.kind,redirect:shouldRedirect(parsed.path)});if(parsed&&((isCursorApiHost(parsed.hostname)&&shouldRedirect(parsed.path))||isConfiguredLocal(parsed)))return directRequest(parsed,options,callback);var original=isHttps?_proxyHttpsRequest:_proxyHttpRequest;return original.call(isHttps?_https:_http,input,options,callback);};}
  function interceptGet(isHttps){return function(input,options,callback){var parsed=parseRequest(input);if(parsed&&((isCursorApiHost(parsed.hostname)&&shouldRedirect(parsed.path))||isConfiguredLocal(parsed))){var request=(isHttps?_https:_http).request(input,options,callback);request.end();return request;}var original=isHttps?_proxyHttpsGet:_proxyHttpGet;return original.call(isHttps?_https:_http,input,options,callback);};}
  _http.request=interceptRequest(false);_https.request=interceptRequest(true);_http.get=interceptGet(false);_https.get=interceptGet(true);
  // Defensive re-assert on the shared builtin module objects once the current
  // bundle has populated its exports: consumers may resolve require("http"/"https")
  // lazily, and this keeps both the wrapper and the raw module objects consistent.
  setTimeout(function(){try{var legacyHttp=require("http"),legacyHttps=require("https");if(legacyHttps&&typeof legacyHttps.request==="function"){legacyHttps.request=_https.request;legacyHttps.get=_https.get;}if(legacyHttp&&typeof legacyHttp.request==="function"){legacyHttp.request=_http.request;legacyHttp.get=_http.get;}routerLog("legacy rebind complete");}catch(e){routerLog("legacy rebind failed",{error:e.message});}},0);
  try{if(typeof _module.syncBuiltinESMExports==="function")_module.syncBuiltinESMExports();}catch(e){console.warn("[BYOK] "+PROCESS_LABEL+" syncBuiltinESMExports failed: "+e.message);}
  console.log("[BYOK] "+PROCESS_LABEL+" HTTP/1.1 whitelist router active (config: "+ROUTES_PATH+")");
})();
/* ${HTTP11_ROUTER_SOURCE_MARKER}-END */\n`;
}

/** Verify executable call sites near the prepended entry payload, not a loose marker. */
export function isNodeHttp11RouterPatched(source, guardMarker) {
  const head = source.slice(0, 24000);
  return head.includes(`/* ${HTTP11_ROUTER_SOURCE_MARKER} */`)
    && head.includes(HTTP11_ROUTER_VERSION_MARKER)
    && head.includes(guardMarker)
    && head.includes('_http.request=interceptRequest(false)')
    && head.includes('_https.request=interceptRequest(true)')
    && head.includes('legacyHttps.request=_https.request')
    && head.includes('_module.syncBuiltinESMExports');
}
