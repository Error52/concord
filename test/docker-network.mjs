/** Older Docker engines require an explicitly configured subnet for fixed-IP regressions. */
export function createTestNetwork(name,docker){
 for(let attempt=0;attempt<3;attempt++){
  docker('network','create',name);
  const subnet=JSON.parse(docker('network','inspect',name))[0].IPAM.Config.find(c=>c.Subnet.includes('.'))?.Subnet;
  docker('network','rm',name);
  if(!subnet)throw new Error('Docker did not allocate an IPv4 test subnet');
  try{return docker('network','create','--subnet',subnet,name);}
  catch(error){if(attempt===2)throw error;}
 }
}
