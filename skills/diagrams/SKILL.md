---
name: diagrams
description: Use when creating or updating diagrams, including architecture, infrastructure, sequence, flowchart, state, or entity-relationship diagrams.
---

# Diagrams

Diagrams are code, rendered to PNG by default. Pick the tool whose strengths fit
what the diagram must show; one request can need both.

- **Python [`diagrams`](https://diagrams.mingrammer.com/)**: recognisable
  provider icons (AWS, GCP, Azure, Kubernetes, on-prem, SaaS), nested boundaries
  such as account, VPC, or cluster, and many-node topologies that Graphviz lays
  out without per-edge hints.
- **Mermaid**: ordering over time (sequence, timeline, Gantt), control flow and
  decisions (flowchart, state), and data models (ER, class). Also any diagram
  that must render inline in Markdown.

Report a missing tool rather than installing it silently.

## Python `diagrams`

Requires `uv` and Graphviz `dot` on `PATH`; without `dot`, rendering fails with
`ExecutableNotFound`.

Save the source as `<name>.py` next to the PNG it produces so the diagram can be
regenerated and diffed. Always pass `show=False`; otherwise the render opens an
image viewer.

```python
from diagrams import Cluster, Diagram, Edge
from diagrams.aws.compute import EKS
from diagrams.aws.database import RDS
from diagrams.aws.network import ALB
from diagrams.aws.storage import S3

with Diagram("Service", filename="service", show=False, direction="LR",
             graph_attr={"pad": "0.2"}):
    with Cluster("VPC"):
        alb = ALB("ALB")
        app = EKS("App")
        alb >> app >> Edge(label="SQL") >> RDS("RDS")
    app >> S3("Assets")
```

```bash
uv run --with diagrams==0.25.1 python service.py   # writes service.png
```

Guessed class names are the usual import failure. List a module's nodes before
importing from it:

```bash
uv run --with diagrams==0.25.1 python -c \
  "import diagrams.aws.network as m; print([n for n in dir(m) if n[0].isupper()])"
```

Providers include `aws`, `gcp`, `azure`, `k8s`, `onprem`, `saas`, and `generic`.
For anything without an icon, use `diagrams.custom.Custom(label, "icon.png")`
with a local image.

If the layout is poor, change `direction`, regroup with `Cluster`, or split the
diagram.

## Other diagrams: Mermaid

Requires `mmdc` (Mermaid CLI). Save the source as `<name>.mmd` next to its PNG.

```bash
mmdc -i flow.mmd -o flow.png -b white -s 2   # white background, 2x scale
```

## Done when

You have viewed the rendered PNG yourself and checked that labels are legible,
no edges or nodes overlap, and every component the user named appears.
