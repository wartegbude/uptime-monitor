import { TargetDetail } from '@/components/detail'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <TargetDetail id={id} />
}
