import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const OUT = '.codex/skills/harness/docs/full-regression-live/20260604T183319Z/artifacts/admin-20260604T183319Z';
const REQUESTED_PREFIX = 'frlive-admin-20260604T183319Z-';
const RESOURCE_PREFIX = REQUESTED_PREFIX.toLowerCase();
const summary = JSON.parse(await fs.readFile(`${OUT}/admin-api-summary.json`, 'utf8'));
function sh(cmd,args){ try{return execFileSync(cmd,args,{encoding:'utf8'});}catch(e){return (e.stdout||'')+(e.stderr||'');}}
function sqlJson(q){ const out=sh('sqlite3',['-json','test/runtime/db/nyabase-test.db',q]).trim(); if(!out)return []; try{return JSON.parse(out);}catch{return [{parseError:out, query:q}];}}
const escReq = REQUESTED_PREFIX.replaceAll("'", "''");
const escLow = RESOURCE_PREFIX.replaceAll("'", "''");
const { userId, groupId, imageId, containerId, operationIds } = summary.created;
const uid=userId?.replaceAll("'", "''");
const gid=groupId?.replaceAll("'", "''");
const iid=imageId?.replaceAll("'", "''");
const cid=containerId?.replaceAll("'", "''");
const proof = {
  checkedAt: new Date().toISOString(),
  requestedPrefix: REQUESTED_PREFIX,
  resourcePrefix: RESOURCE_PREFIX,
  prefixZeroProof: {
    users: sqlJson(`select id,username,displayName,status from users where username like '${escLow}%' or displayName like '${escReq}%' or displayName like '${escLow}%'`),
    groups: sqlJson(`select id,name,isSystem from groups where name like '${escReq}%' or name like '${escLow}%'`),
    images: sqlJson(`select id,name,dockerImage,isActive from images where name like '${escReq}%' or name like '${escLow}%'`),
    activeContainers: sqlJson(`select id,name,server_id as serverId,owner_id as ownerId,deleted_at as deletedAt from containers where (name like '${escLow}%' or name like '${escReq}%') and deleted_at is null`),
  },
  createdIdRows: {
    users: uid ? sqlJson(`select id,username from users where id='${uid}'`) : [],
    groups: gid ? sqlJson(`select id,name from groups where id='${gid}'`) : [],
    images: iid ? sqlJson(`select id,name from images where id='${iid}'`) : [],
    containers: cid ? sqlJson(`select c.id,c.name,c.deleted_at as deletedAt,l.phase,l.bound_runtime_id as boundRuntimeId,l.active_operation_id as activeOperationId from containers c left join container_lifecycle l on l.container_id=c.id where c.id='${cid}'`) : [],
    runtimeContainers: cid ? sqlJson(`select id,server_id as serverId,runtime_id as runtimeId,container_id as containerId,status,stale,last_seen_at as lastSeenAt from runtime_containers where container_id='${cid}'`) : [],
    serverGrants: (uid || gid) ? sqlJson(`select id,scope,scopeId,serverId,cpuMillis,memBytes,diskBytes from server_grants where ${[uid&&`(scope='user' and scopeId='${uid}')`,gid&&`(scope='group' and scopeId='${gid}')`].filter(Boolean).join(' or ') || '0'}`) : [],
    imageGrants: (uid || gid || iid) ? sqlJson(`select id,scope,scopeId,imageId,serverId from image_grants where ${[uid&&`(scope='user' and scopeId='${uid}')`,gid&&`(scope='group' and scopeId='${gid}')`,iid&&`imageId='${iid}'`].filter(Boolean).join(' or ') || '0'}`) : [],
    groupMembers: (uid || gid) ? sqlJson(`select id,groupId,userId from group_members where ${[uid&&`userId='${uid}'`,gid&&`groupId='${gid}'`].filter(Boolean).join(' or ') || '0'}`) : [],
    quotaDesired: uid ? sqlJson(`select id,serverId,userId,numericUserId,limitBytes,generation from quota_desired where userId='${uid}'`) : [],
    operations: cid ? sqlJson(`select id,kind,status,resourceId,serverId,lastError from operations where resourceId='${cid}' order by createdAt`) : [],
    outbox: operationIds?.length ? sqlJson(`select id,operationId,serverId,commandKind,status,lastError from agent_command_outbox where operationId in (${operationIds.map(id=>`'${id.replaceAll("'", "''")}'`).join(',')}) order by createdAt`) : [],
  },
};
const zeroActive = Object.values(proof.prefixZeroProof).every(rows => Array.isArray(rows) && rows.length === 0)
  && ['users','groups','images','serverGrants','imageGrants','groupMembers'].every(k => Array.isArray(proof.createdIdRows[k]) && proof.createdIdRows[k].length === 0)
  && (!proof.createdIdRows.containers.length || proof.createdIdRows.containers.every(r => r.deletedAt && r.phase === 'deleted'))
  && proof.createdIdRows.operations.every(r => r.status === 'succeeded')
  && proof.createdIdRows.outbox.every(r => r.status === 'succeeded');
const residuals = [];
if (proof.createdIdRows.quotaDesired.length) residuals.push({ type: 'quota_desired', classification: 'cleanup-blocked', note: 'No public API deletes quota_desired; residual is zero-limit after cleanup.', rows: proof.createdIdRows.quotaDesired });
if (proof.createdIdRows.runtimeContainers.length) residuals.push({ type: 'runtime_containers_history', classification: 'expected-historical-row', note: 'Runtime observation remains as stale history after successful delete.', rows: proof.createdIdRows.runtimeContainers });
const result = { ...proof, zeroActive, residuals };
await fs.writeFile(`${OUT}/cleanup-proof-final.json`, JSON.stringify(result,null,2)+'\n');
await fs.writeFile(`${OUT}/cleanup-ledger.txt`, [
  `checkedAt=${result.checkedAt}`,
  `requestedPrefix=${REQUESTED_PREFIX}`,
  `resourcePrefix=${RESOURCE_PREFIX}`,
  `zeroActive=${zeroActive}`,
  `createdUserDeleted=${proof.createdIdRows.users.length===0}`,
  `createdGroupDeleted=${proof.createdIdRows.groups.length===0}`,
  `createdImageDeleted=${proof.createdIdRows.images.length===0}`,
  `createdContainerDeleted=${proof.createdIdRows.containers.every(r=>r.deletedAt && r.phase==='deleted')}`,
  `operationsSucceeded=${proof.createdIdRows.operations.every(r=>r.status==='succeeded')}`,
  `outboxSucceeded=${proof.createdIdRows.outbox.every(r=>r.status==='succeeded')}`,
  `residuals=${residuals.map(r=>r.type).join(',') || 'none'}`,
].join('\n')+'\n');
console.log(JSON.stringify({zeroActive,residuals:residuals.map(r=>r.type), wrote:`${OUT}/cleanup-proof-final.json`},null,2));
