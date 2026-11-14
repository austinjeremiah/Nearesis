import RuleView from './rule-view';

export default async function Page({ params }: { params: Promise<{ wid: string; ruleId: string }> }) {
  const { wid, ruleId } = await params;
  return <RuleView wid={wid} ruleId={ruleId} />;
}
