<template>
  <Transition name="toast">
    <div
      v-if="props.isVisible"
      class="toast"
      :data-type="props.type"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span class="icon" aria-hidden="true" v-html="iconSvg"></span>

      <div class="body">
        <h4 class="title">{{ props.title }}</h4>
        <p v-if="props.description" class="desc">{{ props.description }}</p>

        <div
          v-if="props.progress > 0"
          class="track"
          role="progressbar"
          :aria-valuenow="props.progress"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="bar" :style="{ width: props.progress + '%' }"></div>
        </div>
      </div>

      <button class="close" aria-label="Fechar notificação" @click="$emit('close')">×</button>
    </div>
  </Transition>
</template>

<script setup>
import { defineProps, computed } from 'vue'

const props = defineProps({
  isVisible: { type: Boolean, required: true },
  title: { type: String, default: 'Notificação' },
  description: { type: String, default: '' },
  progress: { type: Number, default: 0 },
  type: { type: String, default: 'info' } // 'info' | 'success' | 'error'
})

const iconSvg = computed(() => {
  const base = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  switch (props.type) {
    case 'success':
      return `<svg ${base}><path d="M20 6L9 17l-5-5"/></svg>`
    case 'error':
      return `<svg ${base}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
    default:
      return `<svg ${base}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="1"/></svg>`
  }
})
</script>

<style scoped>
.toast {
  /* Tokens (fixos, sem dark mode) */
  --bg: #ffffff;
  --fg: #0f172a;
  --muted: #64748b;
  --border: #e5e7eb;
  --track: #f1f5f9;
  --accent: #2563eb; /* info */
  --shadow: 0 6px 20px rgba(0,0,0,.06);

  position: fixed;
  bottom: 16px;
  right: 16px;
  width: clamp(260px, 32vw, 360px);
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px 12px;
  padding: 12px;
  user-select: none;
}

.toast[data-type="success"] { --accent: #16a34a; }
.toast[data-type="error"]   { --accent: #ef4444; }

.icon {
  width: 18px;
  height: 18px;
  margin-top: 2px;
  color: var(--accent);
  display: inline-flex;
}

.body { display: grid; gap: 4px; min-width: 0; }
.title {
  font-weight: 600;
  font-size: .95rem;
  margin: 0;
}
.desc {
  margin: 0;
  font-size: .875rem;
  color: var(--muted);
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.close {
  appearance: none;
  background: transparent;
  border: 0;
  font-size: 18px;
  line-height: 1;
  padding: 2px 4px;
  color: var(--muted);
  cursor: pointer;
}
.close:hover { color: var(--fg); }

/* Progress */
.track {
  height: 3px;
  background: var(--track);
  border-radius: 999px;
  overflow: hidden;
  margin-top: 4px;
}
.bar {
  height: 100%;
  background: var(--accent);
  width: 0;
  transition: width .35s ease;
}

/* Animação sutil */
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateY(8px); }
.toast-enter-active,
.toast-leave-active { transition: all .18s ease-out; }

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active { transition: none; }
}
</style>
