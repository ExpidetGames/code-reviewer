# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer's runner side (#745). `git_workspace.py` is the safety core of the slice (#762):
the repository the agent works in, the guard that keeps it on its branch and the runner-owned mirror
every push comes from. The agent, the egress proxy and the job glue come with later changes."""
