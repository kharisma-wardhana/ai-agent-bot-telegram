from ingest.parsers import parse_file


def test_markdown_title_from_heading(lesson_docs):
    doc = parse_file(lesson_docs / "mastering-art-of-prompting.md")
    assert doc is not None
    assert doc.title == "Mastering the Art of Prompting"
    assert doc.source_type == "md"
    assert "Be clear and specific" in doc.text


def test_pdf_transcripts_extract_text(lesson_docs):
    for name in [
        "Video transcript_How large language models work.pdf",
        "Video transcript_What are generative AI models.pdf",
        "Trustworthy AI is crucial for business video transcript_EN.pdf",
    ]:
        doc = parse_file(lesson_docs / name)
        assert doc is not None and doc.source_type == "pdf"
        assert len(doc.text) > 1000, name


def test_saved_html_shell_falls_back_to_companion_files(lesson_docs):
    doc = parse_file(lesson_docs / "AI Fundamentals Glossary _ ALM.html")
    assert doc is not None and doc.source_type == "html"
    assert "AI Fundamentals Glossary" in doc.title
    assert "Algorithm" in doc.text
    assert len(doc.text) > 1000


def test_images_are_unsupported(lesson_docs):
    jpgs = list(lesson_docs.glob("*.jpg"))
    assert jpgs
    assert parse_file(jpgs[0]) is None
