import type {NextApiRequest,NextApiResponse} from 'next';
import {authenticatedCreatorIdentity} from '../../../../server/creator-api-security';
import {getLocalProjectManager} from '../../../../server/local-project-manager';
import {flushActiveEditor} from '../../../../server/local-project-publication';
import {listAiPublications,revertAiPublication} from '../../../../server/ai-project-publication';
export default async function handler(req:NextApiRequest,res:NextApiResponse) {
  res.setHeader('Cache-Control','no-store');
  const identity=await authenticatedCreatorIdentity(req,res,'projects.edit');if(!identity) return;
  const id=String(req.query.id || '');if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return res.status(400).end();
  try {
    const manager=getLocalProjectManager();
    if(req.method==='GET') return res.status(200).json({operations:listAiPublications(manager,id,String(identity.userId))});
    if(req.method==='POST') {
      await Promise.all(manager.listMapGroup(id).map(member=>flushActiveEditor(member.id)));
      return res.status(200).json(revertAiPublication(manager,id,String(identity.userId),String(req.body?.operationId || '')));
    }
    res.setHeader('Allow','GET, POST');return res.status(405).end();
  } catch {return res.status(409).json({message:'发布记录已变化或无法回撤，请先检查项目版本'});}
}
