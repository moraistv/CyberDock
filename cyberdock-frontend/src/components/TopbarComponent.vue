<template>
  <header class="topbar" role="banner">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <router-link
        v-for="(crumb, index) in breadcrumbs"
        :key="index"
        :to="crumb.path"
        class="breadcrumb-link"
      >
        <span class="breadcrumb-text">{{ crumb.name }}</span>
        <span v-if="index < breadcrumbs.length - 1" class="breadcrumb-separator">/</span>
      </router-link>
    </nav>

    <div class="actions">
      <!-- Admin -->
      <button
        v-if="userRole === 'master' && !isAdminMode"
        @click="enterAdminMode"
        class="btn-ghost"
        type="button"
      >
        Painel Administrativo
      </button>
      <button
        v-if="userRole === 'master' && isAdminMode"
        @click="exitAdminMode"
        class="btn-ghost danger"
        type="button"
      >
        Sair do Modo Admin
      </button>

      <!-- Avatar -->
      <div class="avatar-wrap" ref="avatarWrap">
        <button
          class="avatar-btn"
          :aria-expanded="isDropdownOpen ? 'true' : 'false'"
          aria-haspopup="menu"
          @click="onAvatarClick"
          @keydown.down.prevent="openDropdown"
          @keydown.escape.prevent="closeDropdown"
          type="button"
        >
          <span
            class="avatar"
            :style="avatarStyle"
            aria-hidden="true"
            ref="avatarEl"
          >
            {{ userInitials }}
          </span>
          <span class="sr-only">Abrir menu do usuário</span>
        </button>

        <transition @before-enter="beforeEnter" @enter="enter" @leave="leave">
          <div
            v-if="isDropdownOpen"
            class="dropdown"
            role="menu"
            tabindex="-1"
            ref="dropdownEl"
          >
            <router-link to="/profile" class="dropdown-item" role="menuitem" @click="closeDropdown">
              Perfil
            </router-link>
            <button class="dropdown-item" role="menuitem" @click="logoutAndClose">
              Sair
            </button>
          </div>
        </transition>
      </div>
    </div>
  </header>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { gsap } from 'gsap';
import { useAuth } from '@/composables/useAuth';
import { useAdminMode } from '@/composables/useAdminMode';

const router = useRouter();
const route = useRoute();
const { user, userRole, logout, refreshUserData } = useAuth();
const { isAdminMode, setAdminMode } = useAdminMode();

const isDropdownOpen = ref(false);
const avatarWrap = ref(null);
const avatarEl = ref(null);
const dropdownEl = ref(null);

onMounted(async () => {
  if (user.value) await refreshUserData();
  if (avatarEl.value) {
    gsap.fromTo(
      avatarEl.value,
      { opacity: 0, y: -6, scale: 0.92 },
      { opacity: 1, y: 0, scale: 1, duration: 0.28, ease: 'power2.out', delay: 0.05 }
    );
  }
  document.addEventListener('click', handleOutsideClick, { capture: true });
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleOutsideClick, { capture: true });
});

watch(route, (r) => setAdminMode(r.path.startsWith('/admin') || r.path.startsWith('/master')));

// ===== Avatar (iniciais, cor e animação) =====
const userInitials = computed(() => {
  if (!user.value) return 'U';
  const base = (user.value.name || user.value.displayName || user.value.email || '').trim();
  if (!base) return 'U';
  const parts = base.replace(/\s+/g, ' ').split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (base.includes('@')) return base[0].toUpperCase();
  return base[0].toUpperCase();
});

function hashHsl(str) {
  if (!str) return { h1: 230, h2: 260, s: 65, l1: 58, l2: 45 };
  const code = Array.from(str).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const h1 = code % 360;
  const h2 = (code >> 3) % 360;
  return { h1, h2, s: 70, l1: 62, l2: 48 };
}

const avatarStyle = computed(() => {
  const base = user.value?.name || user.value?.displayName || user.value?.email || 'user';
  const { h1, h2, s, l1, l2 } = hashHsl(base);
  return {
    background: `linear-gradient(135deg, hsl(${h1} ${s}% ${l1}%) 0%, hsl(${h2} ${s}% ${l2}%) 100%)`,
  };
});

// ===== Breadcrumbs =====
const breadcrumbs = computed(() => {
  const map = {
    '/dashboard': 'Dashboard',
    '/tabela-vendas': 'Tabela de Vendas',
    '/contas': 'Contas',
    '/armazenamento': 'Armazenamento',
    '/resumo-cobranca': 'Resumo de Cobrança',
    '/profile': 'Perfil',
    '/admin': 'Painel Administrativo',
    '/admin/users': 'Usuários',
    '/master/servicos-avulsos': 'Histórico de Serviços' // ROTA ADICIONADA
  };
  const parts = route.path.split('/').filter(Boolean);
  let current = '';
  return parts.map((p) => {
    current += `/${p}`;
    return { name: map[current] || p, path: current };
  });
});

// ===== Dropdown controls =====
const openDropdown = () => (isDropdownOpen.value = true);
const closeDropdown = () => (isDropdownOpen.value = false);
const onAvatarClick = () => {
  isDropdownOpen.value = !isDropdownOpen.value;
  if (avatarEl.value) {
    gsap.fromTo(
      avatarEl.value,
      { scale: 1 },
      { scale: 0.96, duration: 0.08, yoyo: true, repeat: 1, ease: 'power1.inOut' }
    );
  }
};
const logoutAndClose = () => { closeDropdown(); logout(); };

function handleOutsideClick(ev) {
  if (avatarWrap.value && !avatarWrap.value.contains(ev.target)) {
    closeDropdown();
  }
}

// ===== Admin actions =====
const enterAdminMode = () => { setAdminMode(true); router.push('/admin'); };
const exitAdminMode = () => { setAdminMode(false); router.push('/dashboard'); };

// ===== Dropdown animation =====
const beforeEnter = (el) => { gsap.set(el, { opacity: 0, y: -6, scale: 0.98 }); };
const enter = (el, done) => { gsap.to(el, { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: 'power2.out', onComplete: done }); };
const leave = (el, done) => { gsap.to(el, { opacity: 0, y: -6, scale: 0.98, duration: 0.14, ease: 'power2.in', onComplete: done }); };
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600&display=swap');

.topbar{
  --border:#e5e7eb;
  --muted:#6b7280;
  --link:#2563eb;
  --link-hover:#1d4ed8;
  --bg:#ffffff;

  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between;
  gap: .75rem;
  height: 56px;
  padding: 0 .875rem;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.breadcrumbs{
  display: flex; align-items: center; min-width: 0; overflow: hidden;
  font-size: .875rem; color: var(--muted); font-weight: 500;
}
.breadcrumb-link{
  display: inline-flex; align-items: center; gap:.5rem;
  color: var(--link); text-decoration: none; white-space: nowrap;
}
.breadcrumb-link:hover{ color: var(--link-hover); }
.breadcrumb-text{ max-width: 22ch; overflow: hidden; text-overflow: ellipsis; }
.breadcrumb-separator{ margin: 0 .5rem; color: #9ca3af; user-select: none; }
.actions{ display:flex; align-items:center; gap:.5rem; }
.btn-ghost{
  height: 32px; padding: 0 .75rem; border-radius: 999px;
  border: 1px solid var(--border); background: #fff; color:#111827;
  font-weight: 600; font-size: .75rem; line-height: 1;
  transition: transform .06s ease, background .2s ease, border-color .2s ease;
}
.btn-ghost:hover{ background:#f9fafb; border-color:#d1d5db; }
.btn-ghost:active{ transform: translateY(1px); }
.btn-ghost.danger{ color:#b91c1c; }
.avatar-wrap{ position: relative; display:flex; align-items:center; }
.avatar-btn{
  position: relative;
  display:flex; align-items:center; justify-content:center;
  width: 36px; height: 36px; padding:0; border:0; background: transparent; cursor: pointer;
  border-radius: 999px;
  outline: none;
}
.avatar-btn:focus-visible{ box-shadow: 0 0 0 3px rgba(37,99,235,.25); border-radius: 999px; }
.avatar{
  width: 36px; height: 36px; border-radius: 999px;
  color: #fff; font-weight: 700; font-size: .95rem;
  display:flex; align-items:center; justify-content:center;
  letter-spacing: .5px; text-transform: uppercase;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.25), 0 1px 2px rgba(0,0,0,.06);
}
.dropdown{
  position: absolute; top: calc(100% + 8px); right: 0;
  width: 180px;
  background: #fff; border: 1px solid var(--border);
  border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.08);
  padding: .375rem; z-index: 50;
}
.dropdown-item{
  width: 100%; display:block; text-align:left;
  background: transparent; border: 0; cursor: pointer;
  padding: .5rem .625rem; border-radius: 8px;
  color:#111827; font-weight: 600; font-size: .85rem;
}
.dropdown-item:hover{ background:#f3f4f6; }
.sr-only{ position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
</style>
