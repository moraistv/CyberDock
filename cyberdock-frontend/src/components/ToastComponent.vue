<template>
  <section class="toast-container" role="region" aria-live="polite" aria-atomic="true">
    <article
      v-for="toast in toasts"
      :key="toast.id"
      :ref="el => setToastRef(toast.id, el)"
      class="toast"
      :class="toast.type"
      @click="removeToast(toast.id)"
    >
      <div class="toast-icon">
        <!-- SUCCESS -->
        <svg v-if="toast.type === 'success'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 12.5l2.5 2.5 4.5-5" />
        </svg>
        <!-- ERROR -->
        <svg v-else-if="toast.type === 'error'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
        <!-- WARNING -->
        <svg v-else-if="toast.type === 'warning'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3l9 16H3L12 3z" />
          <path d="M12 9v5" />
          <path d="M12 17h.01" />
        </svg>
        <!-- INFO / DEFAULT -->
        <svg v-else viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01" />
          <path d="M11.5 11.5h1v4h-1" />
        </svg>
      </div>

      <p class="toast-message">{{ toast.message }}</p>
      <div class="toast-progress"></div>
    </article>
  </section>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { gsap } from 'gsap'

const toasts = ref([])
const toastEls = new Map()     // id -> HTMLElement
const timelines = new Map()    // id -> { tl, cleanup }
const prefersReduced = typeof window !== 'undefined'
  ? window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  : false

const setToastRef = (id, el) => {
  if (el) toastEls.set(id, el)
  else toastEls.delete(id)
}

const addToast = ({ id, message, type = 'info', duration = 3200 }) => {
  if (toasts.value.some(t => t.id === id)) return
  toasts.value.push({ id, message, type, duration })

  nextTick(() => {
    const el = toastEls.get(id)
    if (!el) return

    const progress = el.querySelector('.toast-progress')

    const tl = gsap.timeline({
      defaults: { ease: 'power2.out' },
      onComplete: () => removeToast(id)
    })

    const enterDur = prefersReduced ? 0 : 0.35
    tl.fromTo(
      el,
      { y: 12, opacity: 0, scale: 0.98 },
      { y: 0, opacity: 1, scale: 1, duration: enterDur }
    )

    const lifeDur = prefersReduced ? 0.01 : duration / 1000
    if (progress) {
      gsap.set(progress, { scaleX: 1, transformOrigin: 'left center' })
      tl.to(progress, { scaleX: 0, duration: lifeDur, ease: 'none' }, 0.05)
    }

    // pausa/resume no hover
    const pause = () => tl.pause()
    const resume = () => tl.resume()
    el.addEventListener('mouseenter', pause)
    el.addEventListener('mouseleave', resume)

    timelines.set(id, {
      tl,
      cleanup: () => {
        el.removeEventListener('mouseenter', pause)
        el.removeEventListener('mouseleave', resume)
      }
    })
  })
}

const removeToast = (id) => {
  const idx = toasts.value.findIndex(t => t.id === id)
  if (idx === -1) return

  const entry = timelines.get(id)
  const el = toastEls.get(id)

  entry?.tl?.kill()
  entry?.cleanup?.()
  timelines.delete(id)

  if (el) {
    gsap.to(el, {
      y: 10,
      opacity: 0,
      scale: 0.98,
      duration: prefersReduced ? 0 : 0.28,
      ease: 'power2.inOut',
      onComplete: () => {
        const i = toasts.value.findIndex(t => t.id === id)
        if (i !== -1) toasts.value.splice(i, 1)
      }
    })
  } else {
    toasts.value.splice(idx, 1)
  }
}

const handleToastEvent = (e) => addToast(e.detail)

onMounted(() => {
  window.addEventListener('show-toast', handleToastEvent)
})

onUnmounted(() => {
  window.removeEventListener('show-toast', handleToastEvent)
  timelines.forEach(({ tl, cleanup }) => { tl?.kill(); cleanup?.() })
  timelines.clear()
})
</script>

<style scoped>
/* ===== Layout claro e minimal ===== */
.toast-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;

  display: flex;
  flex-direction: column;
  gap: 10px;

  pointer-events: none; /* container ignora clique */
}

.toast {
  pointer-events: auto; /* mas o card recebe */
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 12px;

  padding: 12px 14px;
  min-width: 260px;
  max-width: min(92vw, 420px);
  border-radius: 12px;

  background: #fff;
  border: 1px solid #e9eef3;
  box-shadow:
    0 6px 20px rgba(16, 24, 40, 0.06),
    0 1px 2px rgba(16, 24, 40, 0.04);

  color: #111827; /* quase preto */
  font-size: 0.94rem;
  font-weight: 500;
  line-height: 1.35;

  position: relative;
  overflow: clip;
}

/* Acento por tipo via CSS vars (icones/progress) */
.toast.success { --accent: #16a34a; --accent-bg: #E6F6EC; }
.toast.error   { --accent: #dc2626; --accent-bg: #FDECEC; }
.toast.warning { --accent: #d97706; --accent-bg: #FFF3E1; }
.toast.info    { --accent: #2563eb; --accent-bg: #E8F0FE; }

/* Ícone circular com fundo claro */
.toast-icon {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: var(--accent-bg);
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}

/* SVGs limpos, stroke no accent */
.toast-icon svg {
  width: 20px;
  height: 20px;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Mensagem */
.toast-message {
  margin: 0;
  word-break: break-word;
}

/* Barra de progresso fina e discreta */
.toast-progress {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 8px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.35;
  transform: scaleX(1);
  transform-origin: left center;
}

/* feedback sutil no click */
.toast:active { transform: scale(0.995); }

/* Acessibilidade: reduz movimento */
@media (prefers-reduced-motion: reduce) {
  .toast { transition: none !important; }
}
</style>
