CREATE TABLE [dbo].[Actions]
( 
    [Name] NVARCHAR(256) NOT NULL PRIMARY KEY NONCLUSTERED, 
    [Description] NVARCHAR(256) NULL,
    [Xml] [nvarchar](max) NULL
)