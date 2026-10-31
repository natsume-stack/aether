import type { NextApiRequest, NextApiResponse } from 'next';
import {requireVoxaEditorAccess} from '../../../server/model-management-access';
import {setLocalCors} from '../../../server/local-cors';
import {generateVoxaAiPlan, streamVoxaAiPlan, authorizeVoxaAiWrite} from '../../../server/ai-planner';
export const config={api:{bodyParser:{sizeLimit:'256kb'}}};
export default async function handler(req:NextApiRequest,res:NextApiResponse) {
  res.setHeader('Cache-Control','no-store');
  if (!setLocalCors(req,res)) return res.status(403).end();
  if (req.method!=='POST') {res.setHeader('Allow','POST');return res.status(405).end();}
  if (!await requireVoxaEditorAccess(req,res)) return;
  try {
    if(req.query.action==='plan') {
      if(req.body?.stream===true) return streamVoxaAiPlan(req,res);
      return res.status(200).json(await generateVoxaAiPlan(req,res));
    }
    if(req.query.action==='authorize') {const lease=await authorizeVoxaAiWrite(req,res,req.body?.modelId);return res.status(200).json({allowed:true,...lease});}
    return res.status(404).end();
  } catch(error) {
    const message=error instanceof Error ? error.message : 'AI request failed';
    return res.status(400).json({message:message.startsWith('AI provider returned HTTP') || message==='AI execution disabled by administrator' ? message : 'AI request failed; check channel configuration or try again'});
  }
}
