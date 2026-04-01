<template>
  <UniversalModal
    title="Gerenciar Tipos de Pacote"
    :is-open="isOpen"
    size="lg"
    @close="$emit('close')"
  >
    <div class="pkgm">
      <!-- Formulário -->
      <section class="pkgm__form">
        <h3 class="pkgm__subtitle">
          {{ isEditing ? 'Editando Tipo de Pacote' : 'Adicionar Novo Tipo' }}
        </h3>

        <div class="row">
          <div class="fg fg--2">
            <label for="pkg-name">Nome</label>
            <input
              id="pkg-name"
              type="text"
              class="input"
              v-model="editablePackageType.name"
              placeholder="Ex.: Expedição Leve"
            />
          </div>

          <div class="fg fg--1">
            <label for="pkg-price">Preço (R$)</label>
            <input
              id="pkg-price"
              type="number"
              class="input"
              v-model.number="editablePackageType.price"
              placeholder="Ex.: 4,50"
              step="0.01"
              min="0"
            />
          </div>
        </div>

        <div class="form-actions">
          <button
            v-if="isEditing"
            @click="cancelEdit"
            type="button"
            class="btn btn--secondary"
          >
            Cancelar
          </button>
          <button
            @click="handleSave"
            type="button"
            class="btn btn--primary"
          >
            {{ isEditing ? 'Salvar Alterações' : 'Adicionar' }}
          </button>
        </div>
      </section>

      <!-- Lista -->
      <h3 class="pkgm__subtitle">Tipos Existentes</h3>

      <div v-if="isLoading" class="feedback">Carregando...</div>

      <div v-else-if="!packageTypes || packageTypes.length === 0" class="feedback feedback--empty">
        Nenhum tipo cadastrado.
      </div>

      <ul v-else class="list">
        <li v-for="pt in packageTypes" :key="pt.id" class="item">
          <div class="item__info">
            <span class="item__name">{{ pt.name }}</span>
            <span class="item__price">{{ formatCurrency(pt.price) }}</span>
          </div>

          <div class="item__actions">
            <button
              @click="editPackageType(pt)"
              type="button"
              class="icon-btn"
              title="Editar"
              aria-label="Editar tipo de pacote"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"
                   viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>

            <button
              @click="$emit('delete', pt)"
              type="button"
              class="icon-btn icon-btn--danger"
              title="Excluir"
              aria-label="Excluir tipo de pacote"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"
                   viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4
                         a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </li>
      </ul>
    </div>
  </UniversalModal>
</template>

<script>
import { defineComponent, ref } from 'vue'
import UniversalModal from '../UniversalModal.vue'

export default defineComponent({
  name: 'PackageTypeManagerModal',
  components: { UniversalModal },
  props: {
    isOpen: Boolean,
    packageTypes: Array,
    isLoading: Boolean,
  },
  emits: ['close', 'save', 'delete'],
  setup(props, { emit }) {
    const isEditing = ref(false)
    const editablePackageType = ref({ name: '', price: null })

    const formatCurrency = (value) => {
      const n = Number(value)
      if (!isFinite(n)) return 'R$ 0,00'
      return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    }

    const resetForm = () => {
      isEditing.value = false
      editablePackageType.value = { name: '', price: null }
    }

    const editPackageType = (pt) => {
      isEditing.value = true
      editablePackageType.value = { ...pt }
    }

    const cancelEdit = () => resetForm()

    const handleSave = () => {
      const { name, price } = editablePackageType.value
      if (!name || price == null || price < 0) {
        window.dispatchEvent(new CustomEvent('show-toast', {
          detail: {
            id: 'pkg-invalid',
            message: 'Nome e preço válido são obrigatórios.',
            type: 'error',
            duration: 3500
          }
        }))
        return
      }
      emit('save', { ...editablePackageType.value }, isEditing.value)
      resetForm()
    }

    return {
      isEditing,
      editablePackageType,
      formatCurrency,
      editPackageType,
      cancelEdit,
      handleSave,
    }
  },
})
</script>

<style scoped>
/* Garantir que nada estoure o container */
.pkgm, .pkgm * { box-sizing: border-box; }

.pkgm {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* Títulos */
.pkgm__subtitle {
  font-size: 1.05rem;
  font-weight: 700;
  margin: 0 0 0.75rem 0;
  color: #111827;
}

/* Card do formulário */
.pkgm__form {
  padding-bottom: 1rem;
  border-bottom: 1px solid #e5e7eb;
}

/* Linha do formulário em grid (evita overflow) */
.row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 0.9rem;
}
@media (max-width: 720px) {
  .row { grid-template-columns: 1fr; }
}

.fg { display: flex; flex-direction: column; min-width: 0; }
.fg label {
  margin-bottom: 0.4rem;
  font-weight: 600;
  font-size: .875rem;
  color: #374151;
}
.input {
  width: 100%;
  min-width: 0;
  padding: .62rem .8rem;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  background: #fff;
  color: #111827;
  font-size: .92rem;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.input::placeholder { color: #9ca3af; }
.input:focus {
  border-color: #93c5fd;
  box-shadow: 0 0 0 3px rgba(59,130,246,.18);
}

/* Ações do form */
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: .6rem;
  margin-top: .9rem;
}

/* Lista */
.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 8px;
}
.item {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto;
  align-items: center;
  gap: .75rem;
  padding: .8rem .9rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  transition: border-color .15s, box-shadow .15s, transform .15s;
}
.item:hover {
  transform: translateY(-1px);
  border-color: #dbe1ea;
  box-shadow: 0 8px 18px rgba(17,24,39,.06);
}
.item__info { display: flex; align-items: baseline; gap: 1rem; min-width: 0; }
.item__name {
  font-weight: 600; color: #1f2937;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.item__price { color: #16a34a; font-weight: 700; white-space: nowrap; }

/* Botões */
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: .4rem; white-space: nowrap;
  border: 1px solid transparent; border-radius: 10px;
  font-size: .9rem; font-weight: 600;
  padding: .58rem 1rem; cursor: pointer;
  transition: background-color .15s, border-color .15s, box-shadow .15s, transform .08s;
}
.btn:active { transform: translateY(1px); }
.btn--primary { background: #2563eb; color:#fff; border-color:#2563eb; }
.btn--primary:hover { background:#1d4ed8; border-color:#1d4ed8; }
.btn--secondary { background:#f3f4f6; color:#374151; border-color:#e5e7eb; }
.btn--secondary:hover { background:#e5e7eb; }

/* Botões ícone */
.icon-btn {
  width: 36px; height: 36px; padding: 0;
  border-radius: 10px;
  background: #f9fafb; border: 1px solid #e5e7eb; color:#2563eb;
  display: inline-flex; align-items:center; justify-content:center;
  transition: background-color .15s, border-color .15s, box-shadow .15s;
}
.icon-btn:hover { background: #eef2ff; border-color: #dbe1ea; }
.icon-btn--danger { color:#ef4444; }
.icon-btn--danger:hover { background:#fee2e2; border-color:#fecaca; }

/* Feedback */
.feedback {
  text-align:center; padding: 1.25rem;
  color:#6b7280; background:#fff; border:1px dashed #e5e7eb; border-radius:12px;
}
.feedback--empty { font-style: italic; }
</style>
