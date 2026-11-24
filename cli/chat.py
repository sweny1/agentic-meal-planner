import asyncio

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.store.postgres.aio import AsyncPostgresStore
from langgraph.types import Command

from core.config import DB_URI
from agents.head_chef import build_head_chef
from agents.memory import UserContext

# the interactive meal planner chat
# before running: docker compose up -d, uv run -m rag.ingest_recipes, uv run -m mcp_server.server (other terminal)
# run from the project folder:  uv run -m cli.chat
#
# commands:
#   /new         start a new thread (new conversation, long-term memory stays)
#   /user NAME   switch to another user (isolation: they have their own memory and grocery list)
#   /history     how many messages are saved in this thread
#   /quit        exit


async def main():
    async with (
        AsyncPostgresStore.from_conn_string(DB_URI) as store,
        AsyncPostgresSaver.from_conn_string(DB_URI) as checkpointer,
    ):
        # creates the memory tables in Postgres the first time (safe to run every time)
        await store.setup()
        await checkpointer.setup()

        head_chef = await build_head_chef(store, checkpointer)

        user_id = input('Your name: ').strip().lower() or 'guest'
        thread_number = 1
        print(f'\nHi {user_id}! Ask the Head Chef anything. (/new, /user NAME, /history, /quit)\n')

        while True:
            question = input(f'[{user_id} | thread {thread_number}] you: ').strip()
            if not question:
                continue

            thread_id = f'{user_id}-thread-{thread_number}'
            config = {'configurable': {'thread_id': thread_id}}

            if question == '/quit':
                break
            if question == '/new':
                thread_number += 1
                print(f'--- new thread {thread_number} ---\n')
                continue
            if question.startswith('/user '):
                user_id = question.removeprefix('/user ').strip().lower()
                thread_number = 1
                print(f'--- now talking as {user_id} ---\n')
                continue
            if question == '/history':
                state = await head_chef.aget_state(config)
                print(f'--- {len(state.values.get("messages", []))} messages saved in {thread_id} ---\n')
                continue

            context = UserContext(user_id=user_id)
            result = await head_chef.ainvoke({'messages': [('user', question)]}, config, context=context)

            # human in the loop: the agent paused and saved its state in Postgres, now a human decides
            while '__interrupt__' in result:
                actions = result['__interrupt__'][0].value['action_requests']
                decisions = []
                for action in actions:
                    print(f'\n  [approval needed] {action["name"]}({action["args"]})')
                    choice = input('  approve / edit / reject? [a/e/r]: ').strip().lower()
                    if choice == 'e':
                        arg_name = next(iter(action['args']))  # both gated tools have exactly one argument
                        new_value = input(f'  new {arg_name}: ').strip()
                        decisions.append({
                            'type': 'edit',
                            'edited_action': {'name': action['name'], 'args': {arg_name: new_value}},
                        })
                    elif choice == 'r':
                        decisions.append({'type': 'reject', 'message': 'The user rejected this.'})
                    else:
                        decisions.append({'type': 'approve'})
                # resume the same thread: the agent continues from where it paused
                result = await head_chef.ainvoke(Command(resume={'decisions': decisions}), config, context=context)

            print(f'\nHead Chef: {result["messages"][-1].content}\n')


if __name__ == '__main__':
    import sys

    if sys.platform == "win32":
        with asyncio.Runner(
            loop_factory=asyncio.SelectorEventLoop
        ) as runner:
            runner.run(main())
    else:
        asyncio.run(main())
