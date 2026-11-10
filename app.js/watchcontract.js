/* Veltrix · the deposit-watch RESPONSE FORMAT (version 2), read by wallet.js. The backend side is supabase/functions/deposit-watch/contract.ts.
   The old fields checked / failed / credited no longer exist and nothing here depends on them. Works in the browser and in Node (tests). */
(function(root){
  "use strict";
  var NETNAME={BTC:"Bitcoin",LTC:"Litecoin",ETH:"Ethereum",BNB:"BNB Smart Chain",AVAX:"Avalanche",SOL:"Solana",XRP:"XRP Ledger",TRX:"TRON",ERC20:"Ethereum (ERC-20 tokens)"};
  var SYMBOL_NETWORK={BTC:"BTC",LTC:"LTC",ETH:"ETH",BNB:"BNB",AVAX:"AVAX",SOL:"SOL",XRP:"XRP",TRX:"TRX",USDT:"ERC20",USDC:"ERC20",SHIB:"ERC20",LINK:"ERC20"};
  var arr=function(x){return Array.isArray(x)?x:[]};
  function bad(msg){return{ok:false,error:msg,errors:[msg],warnings:[],networks:{},scanner:null,wallet:{balances:[],deposits:[],sends:[]}}}
  /* -> {ok, mode, errors, warnings, networks, scanner, wallet:{balances,deposits,sends}} ; ok=false means "do not trust this answer" */
  function parse(d){
    if(!d||typeof d!=="object")return bad("The balance service returned no answer.");
    if(d.version!==2)return bad("The balance service answered in an unexpected format (version "+d.version+"). Update the app or the deposit-watch function.");
    if(d.ok===false)return bad(String(d.error||"The balance service reported an error."));
    if(d.mode!=="user")return bad("The balance service answered in scan mode; the app only reads user mode.");
    var w=d.wallet;if(!w||typeof w!=="object")return bad("The balance service did not include your wallet.");
    return{ok:true,mode:d.mode,errors:arr(d.errors).map(String),warnings:arr(d.warnings).map(String),networks:d.networks&&typeof d.networks==="object"?d.networks:{},
      scanner:d.scanner&&typeof d.scanner==="object"?d.scanner:null,wallet:{balances:arr(w.balances),deposits:arr(w.deposits),sends:arr(w.sends)}};
  }
  /* changes whenever something the user can see changes: a balance, a deposit (new / status / confirmations), a send (status / confirmations / fee) */
  function signature(p){
    var b=p.wallet.balances.map(function(x){return String(x.symbol).toUpperCase()+":"+Number(x.amount)}).sort().join(",");
    var d=p.wallet.deposits.map(function(x){return[x.id,x.status,x.confirmations].join(":")}).join(",");
    var s=p.wallet.sends.map(function(x){return[x.id,x.status,x.confirmations,x.fee_actual].join(":")}).join(",");
    return b+"|"+d+"|"+s;
  }
  /* human-readable, ACCURATE problems for the networks this user has coins on (the exact error the scanner recorded, never a generic guess) */
  function problems(p,symbols){
    var out=[],want={};
    arr(symbols).concat(p.wallet.balances.map(function(x){return x.symbol}),p.wallet.deposits.map(function(x){return x.symbol})).forEach(function(s){var n=SYMBOL_NETWORK[String(s).toUpperCase()];if(n)want[n]=1});
    Object.keys(want).forEach(function(n){var h=p.networks[n];if(h&&h.ok===false)out.push({network:n,key:n+"|"+(h.error||""),message:(NETNAME[n]||n)+": "+(h.error||"unavailable")+" Balances shown for it may be out of date."})});
    var sc=p.scanner;
    if(!sc)out.push({network:"_scanner",key:"_scanner|none",message:"The blockchain scanner has not reported yet. New deposits may take longer to appear."});
    else if(sc.stale)out.push({network:"_scanner",key:"_scanner|stale",message:"The blockchain scanner has not updated for "+(sc.ageSeconds==null?"a while":Math.max(1,Math.round(sc.ageSeconds/60))+" minutes")+". Balances may be out of date."});
    return out;
  }
  /* deposits that are not final yet, with the status the user should see: pending (seen) / confirming (n of m) */
  function inProgress(p){
    return p.wallet.deposits.filter(function(x){return x.status==="pending"||x.status==="confirming"}).map(function(x){
      return{id:x.id,symbol:x.symbol,amount:x.amount,status:x.status,confirmations:Number(x.confirmations||0),required:x.required_confirmations==null?null:Number(x.required_confirmations)}});
  }
  var api={parse:parse,signature:signature,problems:problems,inProgress:inProgress,NETNAME:NETNAME,SYMBOL_NETWORK:SYMBOL_NETWORK};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.veltrixWatch=api;
})(typeof window!=="undefined"?window:globalThis);
