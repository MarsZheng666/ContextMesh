import {test,expect} from 'vitest'
import {randomUUID} from 'node:crypto'
import {environment} from '../helpers/handoff-environment.js'
test('native upgrade preflight fences idle sessions and refuses running tasks without cancelling them',async()=>{
 const f=await environment()
 try{
  const a=await f.launch('Upgrade',f.source),sessionId=randomUUID()
  await a.rpc('create',{sessionId});await a.rpc('prompt',{sessionId,text:'Remember UPGRADE-PRESERVE-4817.'})
  const before=await f.client.stat(sessionId)
  await expect(a.rpc('m1',{command:{action:'prepare-upgrade'}})).resolves.toEqual({ready:true})
  await expect(a.rpc('create',{sessionId:randomUUID()})).rejects.toThrow()
  await a.rpc('m1',{command:{action:'cancel-upgrade'}})
  await a.rpc('start-running',{sessionId,text:'Keep working on the original fixture task.'})
  await expect(a.rpc('m1',{command:{action:'prepare-upgrade'}})).rejects.toThrow(/Finish|busy|running/)
  const state=await a.rpc('state',{sessionId}) as {running:boolean};expect(state.running).toBe(true)
  expect((await f.client.stat(sessionId))?.incarnation).toBe(before?.incarnation)
 }finally{await f.close()}
},40000)
