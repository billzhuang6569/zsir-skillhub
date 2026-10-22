import { useLayoutEffect, useId, useRef, useState } from 'react'
import { useStore, type View } from '../store/index.js'
import { nextTourTarget, tourCardPosition } from '../lib/onboarding.js'
import { useSpaceCapabilities } from '../lib/use-space-capabilities.js'
import FocusTrapDialog from './FocusTrapDialog.js'

const STOPS: Array<{ id: string; view: View; title: string; text: string }> = [
  { id: 'skills', view: 'skills', title: '我的 Skills', text: '在这里整理、导入和查看自己的 Skill。' },
  { id: 'install', view: 'skills', title: '安装到 Agent', text: '点击 Skill 上的工具按钮安装；也可以在详情中选择工具。' },
  { id: 'marketplace', view: 'marketplace', title: 'Skill 商店', text: '主动浏览官方商店，找到合适的 Skill 后安装。' },
  { id: 'keys', view: 'keys', title: '团队与钥匙', text: '个人钥匙填一次即可共用；空间支持团队时，可创建团队并共享 Skill。' },
]

export default function FeatureTour({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0)
  const [rects, setRects] = useState<DOMRect[]>([])
  const [position, setPosition] = useState<ReturnType<typeof tourCardPosition>>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const direction = useRef<1 | -1>(1)
  const maskId = `tour-${useId().replace(/:/g, '')}`
  const caps = useSpaceCapabilities()
  const stop = STOPS[index]
  const move = (delta: 1 | -1): void => {
    direction.current = delta
    const next = index + delta
    if (next >= STOPS.length) onDone()
    else if (next >= 0) setIndex(next)
  }
  // Each stop starts on its primary action, so Enter advances instead of skipping the tour.
  useLayoutEffect(() => {
    cardRef.current?.querySelector<HTMLButtonElement>('.btn-primary')?.focus({ preventScroll: true })
  }, [index])
  useLayoutEffect(() => {
    setRects([])
    setPosition(null)
    useStore.getState().setView(stop.view)
    let frame = 0
    let timeout: ReturnType<typeof setTimeout> | undefined
    const present = (): boolean => Boolean(document.querySelector<HTMLElement>(`[data-tour="${stop.id}"]`)?.getClientRects().length)
    const waitForTarget = (): void => {
      if (timeout !== undefined) return
      timeout = setTimeout(() => {
        timeout = undefined
        // A hidden or occluded WebView pauses animation frames; a present target is
        // measured directly instead of being skipped.
        if (present()) { measure(); return }
        cancelAnimationFrame(frame)
        const next = nextTourTarget(STOPS.map(item => item.id), index, direction.current, () => true)
        if (next === null) onDoneRef.current(); else setIndex(next)
      }, 1500)
    }
    waitForTarget()
    let previousTarget: HTMLElement | null = null
    let previousGeometry = ''
    let scrollAttempts = 0
    const measure = (): void => {
      // Keep the deadline independent of layout/scroll APIs and the animation frame loop.
      frame = requestAnimationFrame(measure)
      try {
        const target = document.querySelector<HTMLElement>(`[data-tour="${stop.id}"]`)
        if (!target || target.getClientRects().length === 0) {
          setRects(current => current.length ? [] : current)
          setPosition(null)
          previousGeometry = ''
          waitForTarget()
          return
        }
        if (target !== previousTarget) scrollAttempts = 0
        const box = target.getBoundingClientRect()
        // Pages may restore their own scroll after mounting; retry for a few frames.
        // `.app-main` scrolls smoothly, so jump instantly to measure the final position now.
        if ((box.top < 0 || box.bottom > window.innerHeight) && scrollAttempts < 10) {
          scrollAttempts += 1
          try { target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }) }
          catch { /* Scrolling is optional; WebView failures must not block the tour. */ }
        }
        previousTarget = target
        const team = stop.id === 'keys' && caps.teams ? document.querySelector<HTMLElement>('[data-tour="teams"]') : null
        const measured = [target.getBoundingClientRect(), ...(team?.getClientRects().length ? [team.getBoundingClientRect()] : [])]
        const card = cardRef.current?.getBoundingClientRect()
        const nextPosition = card ? tourCardPosition(measured[0], card, { width: window.innerWidth, height: window.innerHeight }) : null
        if (!nextPosition) {
          setRects(current => current.length ? [] : current)
          setPosition(null)
          previousGeometry = ''
          waitForTarget()
          return
        }
        clearTimeout(timeout)
        timeout = undefined
        const geometry = JSON.stringify([measured.map(r => [r.left, r.top, r.width, r.height]), card?.width, card?.height, window.innerWidth, window.innerHeight])
        if (geometry !== previousGeometry && card) {
          previousGeometry = geometry
          setRects(measured)
          setPosition(nextPosition)
        }
      } catch {
        setRects(current => current.length ? [] : current)
        setPosition(null)
        previousGeometry = ''
        waitForTarget()
      }
    }
    frame = requestAnimationFrame(measure)
    return () => { cancelAnimationFrame(frame); clearTimeout(timeout) }
  }, [index, caps.teams])
  return <FocusTrapDialog className="modal-layer onboarding-tour" label={stop.title} onEscape={onDone}>
    <svg className="tour-scrim" aria-hidden="true"><defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%" style={{ maskType: 'luminance' }}><rect width="100%" height="100%" fill="white" />{rects.map((rect, i) => <rect key={i} x={rect.left} y={rect.top} width={rect.width} height={rect.height} rx="10" fill="black" />)}</mask></defs><rect width="100%" height="100%" fill="var(--color-overlay)" mask={`url(#${maskId})`} /></svg>
    {rects.map((rect, i) => <div key={i} className="tour-highlight" aria-hidden="true" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />)}
    <div ref={cardRef} className="modal-card tour-card" style={position ?? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1)
    }}>
      <div className="modal-head"><div><span className="eyebrow">功能导览 · {index + 1} / {STOPS.length}</span><h2>{stop.id === 'keys' && !caps.teams ? '钥匙' : stop.title}</h2></div></div>
      <p className="modal-copy">{stop.text}</p>
      <div className="modal-actions"><button className="btn btn-ghost" onClick={onDone}>跳过导览</button><button className="btn btn-ghost" disabled={index === 0} onClick={() => move(-1)}>上一步</button><button className="btn btn-primary" onClick={() => move(1)}>{index === STOPS.length - 1 ? '完成导览' : '下一站'}</button></div>
    </div>
  </FocusTrapDialog>
}
