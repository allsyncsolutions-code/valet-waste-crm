import { useEffect, useState } from 'react'

// Returns { w, isMobile, isTablet } and updates on resize.
// isMobile: phone (<=720), isTablet: narrow desktop (<=1080) where we collapse the AI dock.
export function useResponsive() {
  const get = () => (typeof window === 'undefined' ? 1280 : window.innerWidth)
  const [w, setW] = useState(get)
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setW(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
    }
  }, [])
  return { w, isMobile: w <= 720, isTablet: w <= 1080 }
}
