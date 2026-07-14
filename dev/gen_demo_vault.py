#!/usr/bin/env python3
"""Generate the QVAC Connect demo vault: ~26 notes across projects/people/concepts/
meetings/daily/reading/areas, with strong LATENT connections (shared entities + topics)
but ZERO wikilinks, so the Connect feature has real missing links to find and write.

Re-running restores every note to its pristine state (wipes any "## Related" section
Connect added), which is what makes the vault re-recordable. Notes only; .obsidian is
left alone. Style: informed-curious, first person, no em dashes."""
import os, shutil, sys

VAULT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo-vault")
NOTE_DIRS = ["projects", "people", "concepts", "meetings", "daily", "reading", "areas"]

NOTES = {
# ---- projects ----
"projects/aurora.md": """# Aurora

Aurora is the app I am building: a second brain that runs entirely on your own machine. It indexes your notes, answers questions about them with citations, and can fine-tune a small model on your writing so the answers come back in your voice.

The bet in one line: retrieval is the memory, a small fine-tuned model is the voice. RAG supplies the facts, the LoRA adapter supplies the style.

It is local-first on purpose. Your notes are the most personal data you have, and they should never have to leave the device to be useful. Marco leads the model side, Lena owns the interface. Priya has been the first real user since March.

#project #ai
""",
"projects/helios.md": """# Helios

Helios is the side experiment: run a trained adapter offline on a phone. The desktop app does the heavy training, Helios is the lightweight viewer that loads the adapter and answers without a network.

The hard part is size. A phone cannot hold a 4B model comfortably, so Helios leans on aggressive quantization to get a 1.7B model down to something that fits and still runs fast. It shares the same adapter format as the main app, so a model trained on the desktop just works.

#project #mobile
""",
"projects/atlas.md": """# Atlas

Atlas is the plumbing: a local model registry plus peer to peer sync so a model you train on one machine can move to another without a server in the middle.

It matters because the whole point is data sovereignty. If syncing your models meant uploading them, we would have given the privacy story away. Atlas keeps everything device to device.

#project #infra
""",
# ---- people ----
"people/marco.md": """# Marco

Marco is my main collaborator. He owns the model side: the fine-tuning recipe, the base-model choice, the evaluation. I handle product and the vault.

How we work: I over-structure, he over-builds, and the friction is useful. He is usually right that you should ship the small model honestly instead of waiting for the big one, and that retrieval should come before fine-tuning because facts matter more than style for most questions.

Our open argument is the default base model for training. He wants 1.7B for speed, I want 4B for coherence.

#person #collaborator
""",
"people/lena.md": """# Lena

Lena designs the interface. The force-directed graph, the onboarding, the way the whole thing should feel calm instead of like a settings panel are all her.

She pushes me on one thing constantly: a feature nobody can find does not exist. That is why the related-notes and link suggestions live where you are already reading, not buried in a menu. She likes the atomic-notes habit because small notes make a graph that is actually legible.

#person #design
""",
"people/sam.md": """# Sam

Sam is the advisor, an ex-founder who has shipped to consumers before. He does not care about the model architecture. He cares about distribution: who installs this, why they tell a friend, and what the first ten minutes feel like.

His recurring note to me is that a local AI tool wins on trust, not benchmarks, and that the messaging should lead with what never leaves your machine. Most of my go-to-market thinking traces back to him.

#person #advisor
""",
"people/priya.md": """# Priya

Priya is the first real user. She has kept a daily journal for years and has thousands of notes, which makes her the perfect stress test.

Her feedback reshaped the roadmap. She does not want a chatbot bolted onto her notes, she wants her notes to become more connected and more searchable on their own. She is the reason I take the linking problem seriously, and she practices spaced repetition on her atomic notes religiously.

#person #user
""",
# ---- concepts ----
"concepts/local-ai.md": """# Local AI

The most personal software should run on the device that holds the personal data. Cloud AI is convenient, but every prompt is a copy of your thinking sent to someone else's computer. On-device models flip that: the model comes to your data.

This is the entire reason the app exists. A model that knows you has to be trained on things you would never upload. So both the training and the inference have to happen locally. The honest framing is that a small local model is a stylistic echo with a good memory, not a frontier brain, and designed around that it overdelivers.

#concept #ai #privacy
""",
"concepts/rag.md": """# Retrieval augmented generation

RAG is how a model answers from documents it was never trained on. You embed your notes into vectors, find the chunks closest in meaning to the question, and hand those to the model as context. The model reasons over text it can actually see instead of guessing from memory.

It is the half of the system that supplies facts. Fine-tuning gives you voice, retrieval gives you truth, and for most questions the truth matters more. The quality lives or dies on the embeddings.

#concept #ai
""",
"concepts/embeddings.md": """# Embeddings

An embedding turns a piece of text into a list of numbers that capture its meaning, so that two notes about the same thing land near each other even if they share no words. Search "morning caffeine routine" and a note titled "coffee" comes back, because meaning, not spelling, is what got compared.

Everything downstream leans on them: semantic search, related-notes, and finding which notes should be linked all reduce to measuring distance between these vectors.

#concept #ai
""",
"concepts/fine-tuning.md": """# Fine-tuning

Fine-tuning adjusts a model's weights on your own examples so it picks up a voice and a body of knowledge that no prompt could fit. We use LoRA, which trains a small adapter instead of the whole model, so it is cheap enough to run on a laptop overnight.

The interesting claim is that training on your notes bakes knowledge into the weights, so the model can answer some things from memory without spending retrieval context on them. Marco owns this part. It pairs naturally with quantization when you want the result to run on a phone.

#concept #ai
""",
"concepts/quantization.md": """# Quantization

Quantization shrinks a model by storing its numbers at lower precision, 4 bits instead of 16, which cuts the memory roughly fourfold for a small quality cost. It is the difference between a model that fits on a phone and one that does not.

It is what makes the mobile viewer possible at all, and it has to be chosen carefully alongside fine-tuning because not every quantized format can still be trained.

#concept #ai
""",
"concepts/privacy.md": """# Privacy

Data sovereignty is the product, not a feature. The promise is simple: your notes, your chats, your trained model never leave your machine unless you move them yourself, device to device.

This is why everything is local-first and why the sync layer refuses to route through a server. The moment a single prompt goes to the cloud, the story is gone, so the bar is zero.

#concept #privacy
""",
"concepts/atomic-notes.md": """# Atomic notes

One idea per note. It sounds fussy until you try to link your thinking and realize that big sprawling documents cannot be connected, only filed. A note that says exactly one thing can be referenced from a dozen others.

The rule I follow: if I cannot give a note a title that is a full claim, it is probably two notes. This is the natural unit to review with spaced repetition, and it is what makes a knowledge graph legible instead of decorative.

#concept #thinking
""",
"concepts/spaced-repetition.md": """# Spaced repetition

You remember something by being asked about it right before you would have forgotten it. Spaced repetition just schedules those moments, stretching the interval each time you get it right.

It works best on small self-contained claims, which is exactly why it pairs with atomic notes: a note that states one idea is a flashcard you already wrote. Priya runs her whole journal this way.

#concept #thinking
""",
# ---- meetings ----
"meetings/2026-01-12-aurora-kickoff.md": """# Aurora kickoff

First real scoping session with Marco and Lena. We agreed the v1 is chat with your vault plus the on-device training, and that the linking feature is what makes it more than a local ChatGPT.

Decisions: Marco starts on the fine-tuning recipe, Lena starts on the graph and onboarding, I write the indexer. We punt mobile to later, which is how Helios became a side track.

#meeting
""",
"meetings/2026-02-03-marco-1on1.md": """# Marco 1:1

The base-model argument again. Marco wants to default training to a 1.7B model because it trains in a few minutes and keeps the loop tight. I want 4B for coherence on longer answers.

We compromised: 4B for chat, 1.7B as the trainable base, because the smaller one quantizes cleanly for the phone. Most of this was really a conversation about fine-tuning cost versus quality.

#meeting
""",
"meetings/2026-02-20-sam-advisor.md": """# Sam advisor call

Sam pushed hard on distribution. His take: nobody downloads a second app for AI, they download it because it does one thing their notes app cannot, and they tell a friend because it feels private.

He wants the whole pitch to lead with what never leaves your machine. This call is where most of the go-to-market plan came from.

#meeting
""",
"meetings/2026-03-10-priya-feedback.md": """# Priya feedback session

Watched Priya use the beta with her real journal. The chat impressed her less than I expected. What lit her up was seeing notes she wrote years apart get surfaced as related.

Her one big ask: stop making me link everything by hand. That feedback is the seed of the whole linking feature. She also wanted her old notes to feed spaced repetition automatically.

#meeting
""",
# ---- daily ----
"daily/2026-01-15.md": """# 2026-01-15

- [x] Ship the vault editor with live preview
- [ ] Call Marco about the fine-tuning recipe
- [ ] Sketch the indexer chunking
- [ ] Coffee with Lena to review the graph mockups

Felt good about Aurora today. The editor finally feels native.
""",
"daily/2026-02-08.md": """# 2026-02-08

- [x] Graph hover states
- [ ] Send Lena the onboarding copy
- [ ] Test retrieval on a bigger note set
- [ ] Email Sam to schedule the advisor call

Long run this morning cleared my head before the build session.
""",
# ---- reading ----
"reading/book-smart-notes.md": """# How to Take Smart Notes

The book that convinced me one idea per note is worth the overhead. The core move is the slip-box: write small permanent notes in your own words and link them, and over time the structure writes your essays for you.

It is the intellectual backbone of how I think about the vault, and it is why I care so much about atomic notes and about making links cheap to create. Closely tied to how spaced repetition keeps those small notes alive.

#reading #thinking
""",
"reading/paper-lora.md": """# LoRA paper

The paper behind the whole training approach. Instead of updating a model's billions of weights, you train two tiny matrices that nudge it, which cuts the cost by orders of magnitude and produces a small adapter you can ship separately.

This is what makes on-device fine-tuning realistic, and pairing it with quantization is what gets a trained model onto a phone.

#reading #ai
""",
# ---- areas ----
"areas/coffee.md": """# Coffee

My morning ritual is a V60 pour-over, a 1 to 16 ratio, 30 second bloom, light roast Ethiopian beans. It is the one analog part of the day before the screens start.

I do my best thinking on the walk to the cafe, which is usually where the knotty Aurora problems untangle themselves.

#area #personal
""",
"areas/health.md": """# Health

Trying to hold two habits: a morning run and a real sleep schedule. The run clears my head before deep work, and the sleep is the difference between a sharp build session and a foggy one.

I notice the days I skip the run show up in the quality of my decisions on the app.

#area #personal
""",
"areas/go-to-market.md": """# Go to market

The plan, mostly downstream of Sam: lead with privacy, ship a beta to people who already keep a lot of notes, and let the linking feature be the thing they show a friend.

The wedge is not "another AI chatbot", it is "your notes, more connected, on your machine". Priya is the prototype of the user this is for.

#area #strategy
""",
}

def main():
    for d in NOTE_DIRS:
        full = os.path.join(VAULT, d)
        if os.path.isdir(full):
            shutil.rmtree(full)
    for rel, content in NOTES.items():
        dest = os.path.join(VAULT, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(content)
    print(f"wrote {len(NOTES)} pristine notes to {VAULT}")

if __name__ == "__main__":
    main()
