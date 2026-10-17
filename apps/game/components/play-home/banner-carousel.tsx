/**
 * play 首页顶部 banner 轮播（照 dao3.fun 的实测骨架换皮）。
 *
 * 只负责结构与交互，样式全部由 apps/game/pages/index.tsx 的 <style jsx> 通过
 * `:global(.playBanner*)` 选择器提供 —— 本仓 components/ 目录没有 styled-jsx 先例
 * （其它组件走 CSS Modules），在无法跑 next build 的现实下，沿用 index.tsx 里
 * 已经稳定编译的那份样式管线是唯一低风险选择。
 *
 * 渲染前置条件由调用方保证：images 为空时本组件返回 null（整块不出现）。
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ArrowUpRight } from 'lucide-react';

import type { PlayBannerImage } from './site-config';

const MOBILE_BREAKPOINT_PX = 640;
const MOBILE_HEIGHT_RATIO = 0.62;
const MIN_BANNER_HEIGHT_PX = 148;

type PlayBannerCarouselProps = {
  images: PlayBannerImage[];
  heightPx: number;
  autoplayMs: number;
};

export function PlayBannerCarousel({
  images,
  heightPx,
  autoplayMs,
}: PlayBannerCarouselProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [assetsSettled, setAssetsSettled] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);

  const count = images.length;
  const slideCount = count > 0 ? count : 1;
  const safeIndex = ((index % slideCount) + slideCount) % slideCount;

  // 首屏渲染必须与服务端一致，故视口宽度只在挂载后测量；窄屏把 banner 压矮，
  // 避免 320px 的桌面高度在手机上进不去地图区。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => setViewportWidth(window.innerWidth || 0);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  useEffect(() => {
    if (count < 2 || paused || autoplayMs <= 0) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % count);
    }, autoplayMs);
    return () => window.clearInterval(timer);
  }, [autoplayMs, count, paused]);

  if (!count) return null;

  const renderedHeight =
    viewportWidth && viewportWidth <= MOBILE_BREAKPOINT_PX
      ? Math.max(MIN_BANNER_HEIGHT_PX, Math.round(heightPx * MOBILE_HEIGHT_RATIO))
      : heightPx;

  const step = (delta: number) => setIndex((current) => (current + delta + count) % count);

  return (
    <section
      className="playBanner"
      aria-label="站点横幅"
      aria-roledescription="轮播"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      style={{ height: `${renderedHeight}px` }}
    >
      {assetsSettled ? null : (
        <div className="playBannerProgress" aria-hidden="true">
          <i />
        </div>
      )}
      <div
        className="playBannerTrack"
        style={{ transform: `translateX(-${safeIndex * 100}%)`, width: `${slideCount * 100}%` }}
      >
        {images.map((image, position) => {
          const active = position === safeIndex;
          const hidden = active ? undefined : true;
          const slide = (
            <div className="playBannerSlide" style={{ width: `${100 / slideCount}%` }}>
              <img
                className="playBannerImage"
                src={image.src}
                alt=""
                draggable={false}
                onLoad={() => setAssetsSettled(true)}
                onError={() => setAssetsSettled(true)}
              />
              <div className="playBannerScrim" aria-hidden="true" />
              {image.title || image.subtitle ? (
                <div className="playBannerCaption">
                  {image.title ? <strong className="playBannerTitle">{image.title}</strong> : null}
                  {image.subtitle ? (
                    <span className="playBannerSubtitle">{image.subtitle}</span>
                  ) : null}
                  <span className="playBannerCta">
                    立即进入
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </span>
                </div>
              ) : null}
            </div>
          );
          // href 已由服务端 + 本模块双重白名单（站内绝对路径或 https）。
          if (!image.href) {
            return (
              <div key={`${image.src}-${position}`} className="playBannerLink" aria-hidden={hidden}>
                {slide}
              </div>
            );
          }
          if (/^https:/i.test(image.href)) {
            return (
              <a
                key={`${image.src}-${position}`}
                className="playBannerLink"
                href={image.href}
                rel="noreferrer"
                aria-label={image.title || '横幅链接'}
                aria-hidden={hidden}
                tabIndex={active ? 0 : -1}
              >
                {slide}
              </a>
            );
          }
          return (
            <Link
              key={`${image.src}-${position}`}
              className="playBannerLink"
              href={image.href}
              aria-label={image.title || '横幅链接'}
              aria-hidden={hidden}
              tabIndex={active ? 0 : -1}
            >
              {slide}
            </Link>
          );
        })}
      </div>

      {count > 1 ? (
        <>
          <button
            className="playBannerArrow playBannerPrev"
            type="button"
            aria-label="上一张横幅"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <button
            className="playBannerArrow playBannerNext"
            type="button"
            aria-label="下一张横幅"
            onClick={() => step(1)}
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
          <div className="playBannerDots" role="tablist" aria-label="横幅切换">
            {images.map((image, position) => (
              <button
                key={`${image.src}-dot-${position}`}
                className={`playBannerDot${position === safeIndex ? ' isActive' : ''}`}
                type="button"
                role="tab"
                aria-selected={position === safeIndex}
                aria-label={`第 ${position + 1} 张横幅`}
                onClick={() => setIndex(position)}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
