import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {TokenAuthority} from '../src/hostdeck/security.js';
import {createHttpBoundary} from '../src/hostdeck/gateway.js';

test('Cloudflare rejection diagnostics identify only safe categories and keep HTTP errors generic',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const issuer='https://fixture.cloudflareaccess.com',audience='fixture';
  const authority=new TokenAuthority({issuer,audience,jwks:createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'fixture'}]})});
  const events:unknown[]=[];
  const boundary=createHttpBoundary({} as any,authority,{issuer,resource:'https://fixture.example/mcp',allowedHosts:['fixture.example'],allowedOrigins:[],
    cloudflareAccess:{audience,clientId:'fixture-client',scopes:['devices:read']},diagnostic:event=>events.push(event)});
  const now=Math.floor(Date.now()/1000);
  const signed=async(aud:string,type='app')=>new SignJWT({sub:'PRIVATE_SUBJECT',type}).setProtectedHeader({alg:'RS256',kid:'fixture'})
    .setIssuer(issuer).setAudience(aud).setIssuedAt(now).setExpirationTime(now+120).sign(privateKey);
  for(const [token,expected] of [[await signed('wrong'),'JWT_AUDIENCE'],[await signed(audience,'user'),'APP_TYPE'],['malformed','JWT_FORMAT']] as const){
    const response=await boundary.fetch(new Request('https://fixture.example/mcp',{method:'POST',headers:{'cf-access-jwt-assertion':token}}));
    assert.equal(response.status,403);assert.equal(await response.text(),'UNAUTHENTICATED');
    assert.equal((events.at(-1) as any).authenticationReason,expected);
    assert.ok(!JSON.stringify(events).includes(token));
  }
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SUBJECT'));
  await boundary.close();
});
