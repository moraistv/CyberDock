<template>
  <UniversalModal title="Confirmar Exclusão" :is-open="isOpen" @close="$emit('close')">
    <div v-if="sku" class="confirm-delete-content">
      <p>Tem certeza que deseja excluir o SKU <strong>{{ sku.sku }}</strong>?</p>
      <p class="warning-text">Esta ação não pode ser desfeita. O SKU só pode ser excluído se o estoque estiver zerado.</p>
    </div>
    <div class="modal-actions">
      <button @click="$emit('close')" class="btn btn-secondary">Cancelar</button>
      <button @click="$emit('confirm')" class="btn btn-danger">Confirmar Exclusão</button>
    </div>
  </UniversalModal>
</template>

<script>
import { defineComponent } from 'vue';
import UniversalModal from '../UniversalModal.vue';

export default defineComponent({
  name: 'ConfirmDeleteModal',
  components: { UniversalModal },
  props: {
    isOpen: Boolean,
    sku: Object,
  },
  emits: ['close', 'confirm'],
});
</script>

<style scoped>
.confirm-delete-content p { margin: 0 0 0.5rem 0; }
.warning-text { font-size: 0.875rem; color: #9ca3af; }
.modal-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #e5e7eb; }
.btn { padding: 0.6rem 1.2rem; font-size: 0.875rem; font-weight: 600; border: none; border-radius: 0.5rem; cursor: pointer; }
.btn-secondary { background-color: #e5e7eb; color: #374151; }
.btn-danger { background-color: #ef4444; color: #fff; }
</style>
