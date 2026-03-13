FROM python:3.12-slim

WORKDIR /app

# Install Python deps
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

# Copy everything
COPY . .

# Railway provides PORT env var
ENV PORT=8787

CMD cd server && uvicorn main:app --host 0.0.0.0 --port ${PORT}
