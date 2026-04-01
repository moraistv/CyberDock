<template>
  <UniversalModal
    :title="isEditing ? 'Editar Kit' : 'Criar Novo Kit'"
    :is-open="isOpen"
    size="lg"
    @close="$emit('close')"
  >
    <form @submit.prevent="handleSave" class="kit-form">
      <!-- Coluna Única com todas as informações -->
      <div class="form-column">
        <!-- Seção de Informações Básicas -->
        <div class="form-section">
          <h4 class="section-title">1. Informações Básicas</h4>
          <div class="form-group" :class="{ 'has-error': errors.sku }">
            <label for="kit-sku">Código SKU do Kit</label>
            <input 
              id="kit-sku" 
              type="text" 
              v-model="editableKit.sku" 
              :disabled="isEditing" 
              required
              placeholder="Ex: KIT-GARRAFA-COPO"
            >
            <small v-if="errors.sku" class="err">{{ errors.sku }}</small>
          </div>
          <div class="form-group" :class="{ 'has-error': errors.descricao }">
            <label for="kit-description">Descrição do Kit</label>
            <textarea 
              id="kit-description" 
              v-model="editableKit.descricao" 
              rows="2" 
              required
              placeholder="Ex: Kit Garrafa Térmica Azul + Copo de Silicone"
            ></textarea>
            <small v-if="errors.descricao" class="err">{{ errors.descricao }}</small>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="editableKit.ativo" class="checkbox-input">
              <div class="checkbox-content">
                <span class="checkbox-title">Kit Ativo</span>
                <small>Se marcado, o kit poderá ser usado em vendas.</small>
              </div>
            </label>
          </div>
        </div>

        <!-- Seção de Pacote -->
        <div class="form-section">
          <h4 class="section-title">2. Embalagem</h4>
          <div class="form-group">
            <label for="package-type-select">Tipo de Pacote (Opcional)</label>
            <select id="package-type-select" v-model="editableKit.package_type_id">
              <option :value="null">Nenhum pacote específico</option>
              <option v-for="p in packageTypes" :key="p.id" :value="p.id">
                {{ p.name }} - {{ formatCurrency(p.price) }}
              </option>
            </select>
          </div>
        </div>


      </div>
    </form>

    <!-- Footer -->
    <template #footer>
      <div class="modal-actions">
        <button @click="$emit('close')" type="button" class="btn btn-secondary">
          Cancelar
        </button>
        <button @click="handleSave" type="button" class="btn btn-primary" :disabled="isSaving || !isFormValid">
          <SpinnerIcon v-if="isSaving" />
          {{ isEditing ? 'Atualizar Kit' : 'Salvar Kit' }}
        </button>
      </div>
    </template>
  </UniversalModal>
</template>

<script>
import { defineComponent, ref, computed, watch, onMounted } from 'vue';
import UniversalModal from '@/components/UniversalModal.vue';

const SpinnerIcon = defineComponent({
  name: 'SpinnerIcon',
  template: `<svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>`
});

export default defineComponent({
  name: 'KitFormModal',
  components: { UniversalModal, SpinnerIcon },
  props: {
    isOpen: { type: Boolean, required: true },
    isEditing: { type: Boolean, default: false },
    kitData: { type: Object, default: null },
    packageTypes: { type: Array, default: () => [] },
    availableSkus: { type: Array, default: () => [] },
    isSaving: { type: Boolean, default: false }
  },
  emits: ['close', 'save'],
  setup(props, { emit }) {
    const editableKit = ref({
      sku: '',
      descricao: '',
      package_type_id: null,
      ativo: true
    });
    const errors = ref({});

    const resetForm = () => {
      editableKit.value = {
        sku: '',
        descricao: '',
        package_type_id: null,
        ativo: true
      };
      errors.value = {};
    };

    const loadKitData = () => {
      if (props.isEditing && props.kitData) {
        editableKit.value = JSON.parse(JSON.stringify(props.kitData));
      } else {
        resetForm();
      }
    };

    const validateForm = () => {
      errors.value = {};
      if (!editableKit.value.sku) errors.value.sku = 'SKU é obrigatório';
      if (!editableKit.value.descricao) errors.value.descricao = 'Descrição é obrigatória';
      return Object.keys(errors.value).length === 0;
    };
    
    const isFormValid = computed(() => {
        return editableKit.value.sku && editableKit.value.descricao;
    });

    const handleSave = () => {
      console.log('🔧 [KitFormModal] handleSave iniciado');
      console.log('📦 [KitFormModal] editableKit.value:', editableKit.value);
      console.log('✅ [KitFormModal] Validando formulário...');
      
      if (!validateForm()) {
        console.error('❌ [KitFormModal] Validação falhou:', errors.value);
        return;
      }
      
      console.log('✅ [KitFormModal] Formulário válido, emitindo evento save');
      console.log('📤 [KitFormModal] Dados a serem enviados:', editableKit.value);
      
      emit('save', editableKit.value);
    };

    const formatCurrency = (value) => {
      if (typeof value !== 'number') return 'R$ 0,00';
      return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    };

    watch(() => props.isOpen, (isOpen) => {
      if (isOpen) loadKitData();
    });

    onMounted(loadKitData);

    return {
      editableKit,
      errors,
      isFormValid,
      handleSave,
      formatCurrency
    };
  }
});
</script>

<style scoped>
.kit-form {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.form-column {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  background: #f9fafb;
}

.section-title {
  margin: 0 0 0.5rem 0;
  color: #111827;
  font-size: 1.125rem;
  font-weight: 600;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 0.75rem;
}

.section-description {
  margin: 0 0 1rem 0;
  color: #6b7280;
  font-size: 0.875rem;
  line-height: 1.5;
}





.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.form-group.has-error input,
.form-group.has-error textarea {
  border-color: #ef4444;
}

label { font-weight: 500; color: #374151; }
input, textarea, select {
  padding: 0.75rem;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  background: white;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}
input:disabled { background: #f3f4f6; color: #6b7280; }
small { color: #6b7280; font-size: 0.75rem; }
.err { color: #ef4444 !important; }

.checkbox-label {
  display: flex; align-items: flex-start; gap: 0.75rem; cursor: pointer;
  padding: 1rem; border: 1px solid #e5e7eb; border-radius: 0.5rem;
  background: white; transition: all 0.2s;
}
.checkbox-label:hover { border-color: #d1d5db; }
.checkbox-input { margin-top: 0.25rem; }
.checkbox-content { display: flex; flex-direction: column; gap: 0.25rem; }
.checkbox-title { font-weight: 500; color: #111827; }

/* Footer e Botões */
.modal-actions {
  display: flex; justify-content: flex-end; gap: 0.75rem;
  padding-top: 1rem; border-top: 1px solid #e5e7eb;
}
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 0.5rem; padding: 0.625rem 1rem; border: none;
  border-radius: 0.5rem; font-weight: 600; cursor: pointer;
  transition: all 0.2s; min-height: 42px;
}
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-primary { background: #6366f1; color: white; }
.btn-primary:hover:not(:disabled) { background: #4f46e5; }
.btn-secondary {
  background: white; color: #374151; border: 1px solid #d1d5db;
}
.btn-secondary:hover:not(:disabled) { background: #f9fafb; }

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spinner { animation: spin 1s linear infinite; }
</style>
