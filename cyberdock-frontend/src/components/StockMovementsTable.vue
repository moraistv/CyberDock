<template>
    <div class="table-container movements-table-wrapper">
        <div class="table-header">
            <h2 class="table-title">Histórico de Movimentações de Estoque</h2>
        </div>
        <table class="sku-table">
            <thead>
                <tr>
                    <th>Data</th>
                    <th>SKU</th>
                    <th>Tipo</th>
                    <th>Quantidade</th>
                    <th>Motivo</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-if="props.isLoading">
                    <td colspan="6" class="feedback-cell">Carregando histórico...</td>
                </tr>
                <tr v-else-if="props.movements.length === 0">
                    <td colspan="6" class="feedback-cell">Nenhuma movimentação registrada.</td>
                </tr>
                <tr v-for="movement in props.movements" :key="movement.id">
                    <td data-label="Data">{{ formatDate(movement.created_at) }}</td>
                    <td data-label="SKU">{{ movement.sku ? movement.sku : 'N/A' }}</td>
                    <td data-label="Tipo">
                        <span :class="['movement-badge', movement.movement_type]">
                            {{ capitalize(movement.movement_type) }}
                        </span>
                    </td>
                    <td data-label="Quantidade" :class="['quantity-change', movement.movement_type]">
                        {{ movement.movement_type === 'entrada' ? '+' : '-' }}{{ movement.quantity_change }}
                    </td>
                    <td data-label="Motivo">{{ movement.reason }}</td>
                    <td data-label="" class="td-actions">
                        <button class="btn-delete" @click="confirmDelete(movement)" title="Excluir movimentação">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M4 7l16 0"/>
                                <path d="M10 11v6"/>
                                <path d="M14 11v6"/>
                                <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/>
                                <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>
                            </svg>
                            Excluir
                        </button>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<script setup>
import { defineProps, defineEmits } from 'vue';

const props = defineProps({
    movements: {
        type: Array,
        required: true,
    },
    isLoading: {
        type: Boolean,
        default: false,
    }
});

const emit = defineEmits(['delete']);

const confirmDelete = (movement) => {
    const msg = `Tem certeza que deseja excluir esta movimentação (${movement.movement_type} ${movement.quantity_change} ${movement.sku || ''})?`;
    if (confirm(msg)) {
        emit('delete', movement.id);
    }
};

const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    // Verifica se a data é válida
    if (isNaN(date.getTime())) {
        return 'Data inválida';
    }
    return date.toLocaleString('pt-BR');
};

const capitalize = (s) => {
    if (typeof s !== 'string' || !s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
};
</script>

<style scoped>
.movements-table-wrapper { margin-top: 2.5rem; }
.table-container { background-color: #ffffff; border-radius: 0.75rem; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1); }
.table-header { padding: 1.5rem; border-bottom: 1px solid #e5e7eb; }
.table-title { font-size: 1.25rem; font-weight: 600; margin: 0; }
.sku-table { width: 100%; border-collapse: collapse; }
.sku-table th, .sku-table td { padding: 1rem 1.5rem; border-bottom: 1px solid #e5e7eb; text-align: left; }
.sku-table thead th { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; background-color: #f9fafb; }
.feedback-cell { text-align: center; padding: 3rem; color: #6b7280; }
.movement-badge { padding: 0.2rem 0.6rem; border-radius: 6px; font-size: 0.8rem; font-weight: 500; color: #fff; }
.movement-badge.entrada { background-color: #16a34a; }
.movement-badge.saida { background-color: #dc2626; }
.quantity-change.entrada { color: #16a34a; font-weight: 600; }
.quantity-change.saida { color: #dc2626; font-weight: 600; }

/* Estilos para o botão de excluir */
.td-actions { text-align: center; }
.btn-delete {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background-color: #fef2f2;
    color: #dc2626;
    border: 1px solid #fecaca;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease-in-out;
    text-decoration: none;
}

.btn-delete:hover {
    background-color: #fee2e2;
    border-color: #fca5a5;
    color: #b91c1c;
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(220, 38, 38, 0.1);
}

.btn-delete:active {
    transform: translateY(0);
    box-shadow: 0 1px 2px rgba(220, 38, 38, 0.1);
}

.btn-delete svg {
    flex-shrink: 0;
}

/* Estilos Responsivos para telas menores */
@media screen and (max-width: 768px) {
    .sku-table thead {
        /* Esconde o cabeçalho da tabela */
        display: none;
    }

    .sku-table tr {
        /* Transforma cada linha em um "card" */
        display: block;
        margin-bottom: 1rem;
        border: 1px solid #e5e7eb;
        border-radius: 0.5rem;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        overflow: hidden;
    }

    .sku-table td {
        display: block;
        padding: 0.75rem 1rem;
        text-align: right; /* Alinha o valor à direita */
        border-bottom: 1px solid #f3f4f6;
        position: relative;
        padding-left: 45%; /* Deixa espaço para o label */
    }

    .sku-table td:last-child {
        border-bottom: 0;
    }

    .sku-table td::before {
        /* Usa o data-label como o título da "coluna" */
        content: attr(data-label);
        position: absolute;
        left: 1rem;
        font-weight: 600;
        color: #4b5563;
        text-align: left;
    }
}
</style>