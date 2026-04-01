# Migração: Remoção do "Armazenamento Proporcional" e Implementação de Cálculo Proporcional no "Armazenamento Base"

## Resumo das Mudanças

Este documento descreve as alterações implementadas para remover o serviço "Armazenamento Proporcional" e implementar o cálculo proporcional diretamente no serviço "Armazenamento Base (até 1m³)".

## O que foi Alterado

### 1. Arquivo `backend/router/billing.js`
- **Removido**: Referência ao serviço `proportional_storage`
- **Implementado**: Cálculo proporcional baseado na data de entrada do usuário
- **Lógica**: 
  - Se o usuário está no mês de entrada: calcula proporcional (397 ÷ 30 dias × dias restantes)
  - Se é mês seguinte: cobra valor integral (R$ 397,00)

### 2. Arquivo `backend/router/storage.js`
- **Removido**: Referência ao serviço `proportional_storage`
- **Implementado**: Cálculo proporcional no serviço base
- **Lógica**: Mesma lógica do billing.js

### 3. Arquivo `backend/utils/init-db.js`
- **Removido**: Criação do serviço `proportional_storage`
- **Atualizado**: Descrição do serviço base para refletir a nova funcionalidade

### 4. Script de Migração
- **Criado**: `backend/utils/remove-proportional-storage.sql`
- **Função**: Migrar usuários existentes e remover o serviço proporcional

## Como Funciona Agora

### Exemplo Prático
- **Usuário entra no dia 12 de agosto**
- **Cálculo**: 397 ÷ 30 × 20 dias = R$ 264,67
- **Próximo mês (setembro)**: R$ 397,00 (valor integral)

### Fórmula do Cálculo
```
Valor Proporcional = (Valor Base / 30 Dias) × Dias Restantes
```

Onde:
- **Valor Base**: R$ 397,00
- **Dias no Mês**: 30 (fixo para todos os meses)
- **Dias Restantes**: Do dia de entrada até o final do mês

## Arquivos Modificados

1. `backend/router/billing.js` - Lógica de faturamento
2. `backend/router/storage.js` - Cálculo de armazenamento
3. `backend/utils/init-db.js` - Inicialização do banco
4. `backend/utils/remove-proportional-storage.sql` - Script de migração

## Como Aplicar as Mudanças

### 1. Backup do Banco
```bash
pg_dump -h localhost -U username -d database_name > backup_before_migration.sql
```

### 2. Executar o Script de Migração
```bash
psql -h localhost -U username -d database_name -f backend/utils/remove-proportional-storage.sql
```

### 3. Reiniciar a Aplicação
```bash
npm run dev
# ou
npm start
```

## Benefícios da Mudança

1. **Simplificação**: Um único serviço com lógica proporcional
2. **Consistência**: Mesma lógica em billing e storage
3. **Manutenibilidade**: Código mais limpo e fácil de manter
4. **Flexibilidade**: Cálculo baseado na data real de entrada do usuário

## Observações Importantes

- **Backup obrigatório** antes da migração
- **Teste em ambiente de desenvolvimento** antes de aplicar em produção
- **Verificação** dos usuários existentes após a migração
- **Monitoramento** dos primeiros faturamentos após a mudança

## Suporte

Em caso de dúvidas ou problemas durante a migração, consulte a documentação ou entre em contato com a equipe de desenvolvimento.

