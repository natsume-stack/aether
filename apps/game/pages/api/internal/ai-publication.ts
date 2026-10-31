import type {NextApiRequest,NextApiResponse} from 'next';
import {timingSafeEqual} from 'node:crypto';
import {allowLoopback,isValidProjectId} from './map-authoring/_guard';
import {getLocalProjectManager} from '../../../server/local-project-manager';
import {flushActiveEditor} from '../../../server/local-project-publication';
import {publishAiProject,revertAiPublication,listAiPublications} from '../../../server/ai-project-publication';
export default async function handler(req:NextApiRequest,res:NextApiResponse) {
  res.setHeader('Cache-Control','no-store');
  if(process.env.BOX_DEPLOYMENT_MODE!=='creator') return res.status(404).end();
  if(!allowLoopback(req,res)) return;
  const expected=Buffer.from(`Bearer ${process.env.PERMISSION_TOKEN_SECRET || ''}`);const supplied=Buffer.from(String(req.headers.authorization || ''));
  if(!process.env.PERMISSION_TOKEN_SECRET || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return res.status(401).end();
  if(req.method!=='POST') return res.status(405).end();
  const {projectId,userId,action,operationId,notes}=req.body || {};
  if(typeof projectId!=='string' || !isValidProjectId(projectId) || !/^[1-9][0-9]{0,9}$/.test(String(userId)) || !['publish','revert','list'].includes(action)) return res.status(400).json({message:'Invalid publication request'});
  try {
    const policy=await fetch(`${String(process.env.BOX_PLAYER_SERVICE_INTERNAL_URL || '').replace(/\/$/,'')}/api/player-ai-internal/policy`,{method:'POST',headers:{Authorization:`Bearer ${process.env.PERMISSION_TOKEN_SECRET}`,'Content-Type':'application/json'},body:JSON.stringify({userId,mapId:projectId}),signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!policy.ok || (await policy.json()).allowed!==true) return res.status(403).json({message:'AI execution disabled'});
    const manager=getLocalProjectManager();
    if(action==='list') return res.status(200).json({operations:listAiPublications(manager,projectId,String(userId))});
    const members=manager.listMapGroup(projectId);await Promise.all(members.map(member=>flushActiveEditor(member.id)));
    if(res.destroyed || req.aborted) return;
    return res.status(200).json(action==='publish'?publishAiProject(manager,projectId,String(userId),String(notes || '')):revertAiPublication(manager,projectId,String(userId),String(operationId || '')));
  } catch {return res.status(409).json({message:'Publication failed or its state changed; inspect project releases before retrying'});}
}
