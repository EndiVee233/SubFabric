/** Produce only the pure desktop sentinel helper, including its constants. No server/runtime code. */
export function hardsubBrowserModule(source){
  const helper=source.match(/^function injectSacrificialEvent\(text\) \{[\s\S]*?^\}/m);
  const constants=[...source.matchAll(/^const SACRIFICIAL_\w+\s*=.*;$/gm)].map(match=>match[0]).join('\n');
  if(!helper||!constants.includes('SACRIFICIAL_START')||!constants.includes('SACRIFICIAL_END'))throw new Error('Review Android ASS export sentinel integration');
  return constants+'\nexport '+helper[0];
}
