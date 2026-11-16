# Testes de regressão e acesso

Estes testes usam Chromium e Playwright. Todos os endpoints de Auth/PostgreSQL/Realtime são interceptados com dados fictícios; nenhum teste envia e-mails ou se conecta ao Supabase real. O teste `auth-flows.cjs` executa o SDK Supabase real já incorporado ao HTML. O teste `regression-multiusuario.cjs` usa SDK e backend simulados compartilhados.

Na raiz do repositório, com Node.js instalado:

```sh
npm install --no-save playwright
npx playwright install chromium
node testes/auth-flows.cjs
node testes/regression-multiusuario.cjs
```

Se o Chromium já estiver instalado em outro caminho, use `CHROMIUM_PATH=/caminho/chromium`. É possível definir `TEST_RESULTS_DIR` para gravar evidências JSON fora dos arquivos de aplicação.

Cobertura de Auth (14 cenários): login existente, leitura de seis projetos, gravação e leitura após reabrir a página; convite/recuperação com fragmento de sessão; `token_hash` pelo `verifyOtp`; atualização de senha pelo `updateUser`; retorno ao login normal; confirmação/tamanho de senha; solicitação de recuperação e redirect de produção; callback inválido, expirado ou incompleto; erro de PKCE sem verificador; erro de validação da API e limite de envio de recuperação. O login fica oculto no fluxo de senha e o botão Entrar da barra não permite contornar esse fluxo. O botão Desconectar existente também cancela o formulário de convite, apaga os campos de senha e permite login normal em seguida. O botão Desconectar durante um convite limpa a sessão/telas e permite novo login normal. Não há chamada de cadastro público.

Cobertura multiusuário: seis sessões, salvamento concorrente em projetos diferentes, atualização compartilhada, preservação de rascunho, rejeição por versão antiga, recarga de conflito e ausência de persistência local.

Os resultados simulados **não comprovam** entrega de e-mails, URL Configuration, Auth real, RLS real, trigger SQL, persistência PostgreSQL ou Realtime reais. Esses pontos exigem o roteiro manual de validação com uma conta de teste autorizada e os links reais enviados pelo Supabase.
