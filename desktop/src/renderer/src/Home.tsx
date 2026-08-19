import { useQuery } from '@tanstack/react-query'

export function Home() {
  const info = useQuery({ queryKey: ['app:info'], queryFn: () => window.labDesk.appInfo() })

  return (
    <main>
      <h1>Lab Desk</h1>
      <p>등록된 장비가 없습니다. 탐색은 다음 단계에서 들어옵니다.</p>
      <footer>
        {info.data
          ? `v${info.data.version} · Electron ${info.data.electron} · Node ${info.data.node}`
          : info.isError
            ? 'main process에 연결하지 못했습니다'
            : '…'}
      </footer>
    </main>
  )
}
