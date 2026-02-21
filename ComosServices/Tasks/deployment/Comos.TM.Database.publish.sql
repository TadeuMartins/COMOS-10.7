/*
Deployment script for TasksDB

Please edit the following line and change "TasksDB" 
to the name of your existing database
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
:setvar DatabaseName "YourDatabase"
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
*/

GO
SET ANSI_NULLS, ANSI_PADDING, ANSI_WARNINGS, ARITHABORT, CONCAT_NULL_YIELDS_NULL, QUOTED_IDENTIFIER ON;

SET NUMERIC_ROUNDABORT OFF;


GO
:setvar DatabaseName "TasksDB"

GO
:on error exit
GO
/*
Detect SQLCMD mode and disable script execution if SQLCMD mode is not supported.
To re-enable the script after enabling SQLCMD mode, execute the following:
SET NOEXEC OFF; 
*/
:setvar __IsSqlCmdEnabled "True"
GO
IF N'$(__IsSqlCmdEnabled)' NOT LIKE N'True'
    BEGIN
        PRINT N'SQLCMD mode must be enabled to successfully execute this script.';
        SET NOEXEC ON;
    END


GO
USE [$(DatabaseName)];


GO
PRINT N'Creating User-Defined Table Type [dbo].[TM_Comos_Related_TableType]...';


GO
CREATE TYPE [dbo].[TM_Comos_Related_TableType] AS TABLE (
    [ComosRelatedId]  INT            NULL,
    [ComosType]       NVARCHAR (20)  NULL,
    [ComosNestedName] NVARCHAR (256) NULL,
    [FieldId]         INT            NULL,
    [SyncValue]       NVARCHAR (MAX) NULL);


GO
PRINT N'Creating Table [dbo].[TM_Attachments]...';


GO
CREATE TABLE [dbo].[TM_Attachments] (
    [Id]         INT             IDENTITY (1, 1) NOT NULL,
    [TaskId]     INT             NOT NULL,
    [Name]       NVARCHAR (256)  NOT NULL,
    [Size]       INT             NOT NULL,
    [UploadDate] DATETIME2 (7)   NULL,
    [Content]    VARBINARY (MAX) NULL,
    [Comment]    NVARCHAR (255)  NULL,
    PRIMARY KEY NONCLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Comos_DataBaseInfo]...';


GO
CREATE TABLE [dbo].[TM_Comos_DataBaseInfo] (
    [ComosDatabase] NVARCHAR (50) NOT NULL,
    [SequenceId]    BIGINT        NOT NULL,
    [InProcessing]  BIT           NOT NULL,
    PRIMARY KEY CLUSTERED ([ComosDatabase] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Comos_Link]...';


GO
CREATE TABLE [dbo].[TM_Comos_Link] (
    [Id]              INT            IDENTITY (1, 1) NOT NULL,
    [ComosDatabase]   VARCHAR (50)   NOT NULL,
    [ComosProjId]     VARCHAR (50)   NOT NULL,
    [ComosWoId]       VARCHAR (50)   NULL,
    [ComosObjectUid]  VARCHAR (50)   NOT NULL,
    [ComosSystemType] VARCHAR (50)   NULL,
    [Name]            NVARCHAR (256) NULL,
    [Label]           NVARCHAR (256) NULL,
    [Description]     NVARCHAR (256) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Comos_Related]...';


GO
CREATE TABLE [dbo].[TM_Comos_Related] (
    [Id]              INT            IDENTITY (1, 1) NOT NULL,
    [TaskId]          INT            NOT NULL,
    [ComosDatabase]   VARCHAR (50)   NOT NULL,
    [ComosProjId]     VARCHAR (50)   NOT NULL,
    [ComosWoId]       VARCHAR (50)   NULL,
    [ComosObjectUid]  VARCHAR (50)   NOT NULL,
    [ComosSystemType] VARCHAR (50)   NULL,
    [Name]            NVARCHAR (256) NULL,
    [Label]           NVARCHAR (256) NULL,
    [Description]     NVARCHAR (256) NULL,
    [IsSync]          BIT            NOT NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Fields]...';


GO
CREATE TABLE [dbo].[TM_Fields] (
    [Id]            INT            IDENTITY (1, 1) NOT NULL,
    [Name]          NVARCHAR (256) NOT NULL,
    [DisplayName]   NVARCHAR (256) NOT NULL,
    [Type]          INT            NOT NULL,
    [ReferenceName] NVARCHAR (256) NULL,
    [Description]   NVARCHAR (256) NOT NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    UNIQUE NONCLUSTERED ([Name] ASC),
    CONSTRAINT [UK_Name] UNIQUE NONCLUSTERED ([Name] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_LinkTypes]...';


GO
CREATE TABLE [dbo].[TM_LinkTypes] (
    [Id]              INT            IDENTITY (100, 1) NOT NULL,
    [Name]            NVARCHAR (256) NOT NULL,
    [ForwardRelation] NVARCHAR (256) NOT NULL,
    [ReverseRelation] NVARCHAR (256) NOT NULL,
    [IsDirected]      BIT            NOT NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [AK_Name] UNIQUE NONCLUSTERED ([Name] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Queries]...';


GO
CREATE TABLE [dbo].[TM_Queries] (
    [Id]          INT            IDENTITY (1, 1) NOT NULL,
    [ParentId]    INT            NULL,
    [Name]        NVARCHAR (256) NOT NULL,
    [Description] NVARCHAR (256) NULL,
    [Query]       NVARCHAR (MAX) NULL,
    [Owner]       NCHAR (20)     NOT NULL,
    [IsFolder]    BIT            NOT NULL,
    [IsShared]    BIT            NOT NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Rules]...';


GO
CREATE TABLE [dbo].[TM_Rules] (
    [Id]               INT            IDENTITY (1, 1) NOT NULL,
    [RuleType]         INT            NOT NULL,
    [FieldId]          INT            NOT NULL,
    [TaskTypeId]       INT            NOT NULL,
    [StateId]          INT            NULL,
    [TransitionId]     INT            NULL,
    [Field1]           NVARCHAR (256) NULL,
    [Field1IsConstant] BIT            NULL,
    [Field2]           NVARCHAR (256) NULL,
    [Field2IsConstant] BIT            NULL
);


GO
PRINT N'Creating Table [dbo].[TM_States]...';


GO
CREATE TABLE [dbo].[TM_States] (
    [Id]         INT            IDENTITY (1, 1) NOT NULL,
    [Name]       NVARCHAR (256) NOT NULL,
    [TaskTypeId] INT            NOT NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [UK_StateUsage] UNIQUE NONCLUSTERED ([TaskTypeId] ASC, [Name] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_TaskEntities]...';


GO
CREATE TABLE [dbo].[TM_TaskEntities] (
    [Id]                           INT                   IDENTITY (1, 1) NOT NULL,
    [Name]                         NVARCHAR (256)        NULL,
    [Label]                        NVARCHAR (256)        NULL,
    [TaskType]                     NVARCHAR (256)        NOT NULL,
    [Description]                  NVARCHAR (256)        NULL,
    [State]                        NVARCHAR (256)        NULL,
    [ChangedBy]                    VARCHAR (50)          NULL,
    [ChangedDateTime]              DATETIME2 (7)         NOT NULL,
    [Priority]                     INT                   NULL,
    [CustomerId]                   NVARCHAR (256)        NULL,
    [CreateDateTime]               DATETIME2 (7)         NOT NULL,
    [StartDateTime]                DATETIME2 (7)         NULL,
    [PlanStartDateTime]            DATETIME2 (7)         NULL,
    [EndDateTime]                  DATETIME2 (7)         NULL,
    [PlanEndDateTime]              DATETIME2 (7)         NULL,
    [Responsible]                  VARCHAR (50)          NULL,
    [Deputy]                       VARCHAR (50)          NULL,
    [Creator]                      VARCHAR (50)          NULL,
    [Project]                      NVARCHAR (256)        NULL,
    [Comment]                      NVARCHAR (256)        NULL,
    [Classification]               NVARCHAR (256) SPARSE NULL,
    [CustomId]                     NVARCHAR (256) SPARSE NULL,
    [PercentComplete]              FLOAT (53) SPARSE     NULL,
    [Completed]                    BIT                   NULL,
    [Qualification]                NVARCHAR (256) SPARSE NULL,
    [EstimatedWorkingTime]         FLOAT (53) SPARSE     NULL,
    [AbsolvedWorkingTime]          FLOAT (53) SPARSE     NULL,
    [NotNecessary]                 BIT                   NULL,
    [WorkExecution]                NVARCHAR (MAX) SPARSE NULL,
    [WorkInstruction]              NVARCHAR (MAX) SPARSE NULL,
    [Step]                         NVARCHAR (256)        NULL,
    [ReferenceObject]              NVARCHAR (256)        NULL,
    [Status]                       NVARCHAR (256) SPARSE NULL,
    [DegreeOfCompletionHours]      FLOAT (53) SPARSE     NULL,
    [DegreeOfCompletionActivities] FLOAT (53) SPARSE     NULL,
    [StateOfWorkpackage]           NVARCHAR (256) SPARSE NULL,
    [ActualStartDateTime]          DATETIME2 (7) SPARSE  NULL,
    [Cancelled]                    BIT SPARSE            NULL,
    [Progress]                     FLOAT (53) SPARSE     NULL,
    [AdditionalNecessary]          BIT SPARSE            NULL,
    [Equipment]                    VARCHAR (50) SPARSE   NULL,
    [Unit]                         VARCHAR (50) SPARSE   NULL,
    [TaskOwner]                    NVARCHAR (50) SPARSE  NULL,
    [MaintenancePlanObject]        VARCHAR (50) SPARSE   NULL,
    [Priorities]                   NVARCHAR (256) SPARSE NULL,
    [CreatedByComos]               BIT                   NULL,
    [EngineeringObject]            VARCHAR (50) SPARSE   NULL,
    [Owner]                        VARCHAR (50) SPARSE   NULL,
    [AnnotationData]               NVARCHAR (MAX) SPARSE NULL,
    [ComosObjects]                 VARCHAR (1100) SPARSE NULL,
    [DocumentNo]                   NVARCHAR (256) SPARSE NULL,
    [Subject]                      NVARCHAR (256) SPARSE NULL,
    [Keyword]                      NVARCHAR (256) SPARSE NULL,
    [Role]                         NVARCHAR (256) SPARSE NULL,
    [RequestForReject]             NVARCHAR (256) SPARSE NULL,
    [DocumentRevision]             NVARCHAR (50) SPARSE  NULL,
    [DueDate]                      DATETIME2 (7) SPARSE  NULL,
    [TaskCanceled]                 BIT SPARSE            NULL,
    [TaskClosed]                   BIT SPARSE            NULL,
    [Accept]                       BIT SPARSE            NULL,
    [Reason]                       NVARCHAR (256) SPARSE NULL,
    [TaskCompleted]                BIT SPARSE            NULL,
    [EditComment]                  NVARCHAR (MAX) SPARSE NULL,
    [Reject]                       BIT SPARSE            NULL,
    [SignComment]                  NVARCHAR (256) SPARSE NULL,
    [ReviewComments]               NVARCHAR (MAX) SPARSE NULL,
    [WorkflowInstanceId]           NVARCHAR (256) SPARSE NULL,
    [DocumentStatus]               NVARCHAR (256) SPARSE NULL,
    [DocumentOwner]                NVARCHAR (256) SPARSE NULL,
    [ComosTaskID]                  INT                   NULL,
    [KindOfDocument]               NVARCHAR (256)        NULL,
    PRIMARY KEY NONCLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_TaskHistory]...';


GO
CREATE TABLE [dbo].[TM_TaskHistory] (
    [Id]              INT            NOT NULL,
    [AuditId]         INT            NOT NULL,
    [ChangedBy]       NVARCHAR (256) NULL,
    [ChangedDateTime] DATETIME2 (7)  NOT NULL,
    [HistoryData]     NVARCHAR (MAX) NULL
);


GO
PRINT N'Creating Table [dbo].[TM_TaskLinks]...';


GO
CREATE TABLE [dbo].[TM_TaskLinks] (
    [Id]              INT            IDENTITY (1, 1) NOT NULL,
    [SourceTaskId]    INT            NOT NULL,
    [TargetTaskId]    INT            NOT NULL,
    [LinkTypeId]      INT            NOT NULL,
    [Comment]         NVARCHAR (255) NOT NULL,
    [ChangedBy]       INT            NULL,
    [ChangedDateTime] DATETIME2 (7)  NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_TaskTypeFieldMap]...';


GO
CREATE TABLE [dbo].[TM_TaskTypeFieldMap] (
    [Id]              INT            IDENTITY (1, 1) NOT NULL,
    [TaskTypeId]      INT            NOT NULL,
    [FieldId]         INT            NOT NULL,
    [ComosNestedName] NVARCHAR (256) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [UK_FieldUsage] UNIQUE NONCLUSTERED ([TaskTypeId] ASC, [FieldId] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_TaskTypes]...';


GO
CREATE TABLE [dbo].[TM_TaskTypes] (
    [Id]                  INT            IDENTITY (1, 1) NOT NULL,
    [Name]                NVARCHAR (256) NOT NULL,
    [Description]         NVARCHAR (256) NULL,
    [LayoutId]            INT            NULL,
    [ComosClassification] NVARCHAR (256) NULL,
    CONSTRAINT [PK_TM_TaskTypes] PRIMARY KEY CLUSTERED ([Id] ASC),
    UNIQUE NONCLUSTERED ([Name] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Transitions]...';


GO
CREATE TABLE [dbo].[TM_Transitions] (
    [Id]                    INT IDENTITY (1, 1) NOT NULL,
    [FromStateId]           INT NULL,
    [ToStateId]             INT NOT NULL,
    [AllowedUserGroupSetId] INT NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [UK_Transition] UNIQUE NONCLUSTERED ([FromStateId] ASC, [ToStateId] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Users]...';


GO
CREATE TABLE [dbo].[TM_Users] (
    [Id]        INT            IDENTITY (1, 1) NOT NULL,
    [UID]       VARCHAR (50)   NOT NULL,
    [FirstName] NVARCHAR (256) NULL,
    [LastName]  NVARCHAR (256) NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [AK_UID] UNIQUE NONCLUSTERED ([UID] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_ValueLists]...';


GO
CREATE TABLE [dbo].[TM_ValueLists] (
    [Id]            INT              IDENTITY (1, 1) NOT NULL,
    [ParentId]      INT              NULL,
    [Name]          NVARCHAR (256)   NULL,
    [Value]         NVARCHAR (256)   NULL,
    [Description]   NVARCHAR (256)   NULL,
    [TranslationId] UNIQUEIDENTIFIER NULL,
    PRIMARY KEY CLUSTERED ([Id] ASC),
    CONSTRAINT [AK_TM_ValueLists_Name] UNIQUE NONCLUSTERED ([Name] ASC, [ParentId] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_Version]...';


GO
CREATE TABLE [dbo].[TM_Version] (
    [DatabaseVersionMajor] INT NOT NULL,
    [DatabaseVersionMinor] INT NOT NULL,
    [DatabaseVersionPatch] INT NOT NULL,
    PRIMARY KEY CLUSTERED ([DatabaseVersionMajor] ASC)
);


GO
PRINT N'Creating Table [dbo].[TM_XmlProperties]...';


GO
CREATE TABLE [dbo].[TM_XmlProperties] (
    [Id]    INT            IDENTITY (1, 1) NOT NULL,
    [Name]  NVARCHAR (256) NOT NULL,
    [Value] NVARCHAR (MAX) NOT NULL,
    CONSTRAINT [PK_TM_XmlProperties] PRIMARY KEY CLUSTERED ([Id] ASC)
);


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Attachments]...';


GO
ALTER TABLE [dbo].[TM_Attachments]
    ADD DEFAULT SYSDATETIME  ( ) FOR [UploadDate];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Comos_DataBaseInfo]...';


GO
ALTER TABLE [dbo].[TM_Comos_DataBaseInfo]
    ADD DEFAULT 0 FOR [InProcessing];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Comos_Related]...';


GO
ALTER TABLE [dbo].[TM_Comos_Related]
    ADD DEFAULT 0 FOR [IsSync];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Fields]...';


GO
ALTER TABLE [dbo].[TM_Fields]
    ADD DEFAULT '' FOR [Description];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_LinkTypes]...';


GO
ALTER TABLE [dbo].[TM_LinkTypes]
    ADD DEFAULT '' FOR [ForwardRelation];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_LinkTypes]...';


GO
ALTER TABLE [dbo].[TM_LinkTypes]
    ADD DEFAULT '' FOR [ReverseRelation];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_LinkTypes]...';


GO
ALTER TABLE [dbo].[TM_LinkTypes]
    ADD DEFAULT 1 FOR [IsDirected];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Queries]...';


GO
ALTER TABLE [dbo].[TM_Queries]
    ADD DEFAULT ((0)) FOR [IsFolder];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Queries]...';


GO
ALTER TABLE [dbo].[TM_Queries]
    ADD DEFAULT ((0)) FOR [IsShared];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Rules]...';


GO
ALTER TABLE [dbo].[TM_Rules]
    ADD DEFAULT ((0)) FOR [Field1IsConstant];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_Rules]...';


GO
ALTER TABLE [dbo].[TM_Rules]
    ADD DEFAULT ((0)) FOR [Field2IsConstant];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_TaskEntities]...';


GO
ALTER TABLE [dbo].[TM_TaskEntities]
    ADD DEFAULT SYSDATETIME  ( ) FOR [ChangedDateTime];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_TaskEntities]...';


GO
ALTER TABLE [dbo].[TM_TaskEntities]
    ADD DEFAULT SYSDATETIME  ( ) FOR [CreateDateTime];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_TaskHistory]...';


GO
ALTER TABLE [dbo].[TM_TaskHistory]
    ADD DEFAULT SYSDATETIME  ( ) FOR [ChangedDateTime];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_TaskLinks]...';


GO
ALTER TABLE [dbo].[TM_TaskLinks]
    ADD DEFAULT '' FOR [SourceTaskId];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_TaskLinks]...';


GO
ALTER TABLE [dbo].[TM_TaskLinks]
    ADD DEFAULT '' FOR [TargetTaskId];


GO
PRINT N'Creating Default Constraint unnamed constraint on [dbo].[TM_TaskLinks]...';


GO
ALTER TABLE [dbo].[TM_TaskLinks]
    ADD DEFAULT '' FOR [Comment];


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_Attachments_TaskId]...';


GO
ALTER TABLE [dbo].[TM_Attachments]
    ADD CONSTRAINT [FK_TM_Attachments_TaskId] FOREIGN KEY ([TaskId]) REFERENCES [dbo].[TM_TaskEntities] ([Id]) ON DELETE CASCADE;


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_Comos_Related_TaskId]...';


GO
ALTER TABLE [dbo].[TM_Comos_Related]
    ADD CONSTRAINT [FK_TM_Comos_Related_TaskId] FOREIGN KEY ([TaskId]) REFERENCES [dbo].[TM_TaskEntities] ([Id]) ON DELETE CASCADE;


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_Queries_ParentId]...';


GO
ALTER TABLE [dbo].[TM_Queries]
    ADD CONSTRAINT [FK_TM_Queries_ParentId] FOREIGN KEY ([ParentId]) REFERENCES [dbo].[TM_Queries] ([Id]);


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_Rules_TaskTypeId]...';


GO
ALTER TABLE [dbo].[TM_Rules]
    ADD CONSTRAINT [FK_TM_Rules_TaskTypeId] FOREIGN KEY ([TaskTypeId]) REFERENCES [dbo].[TM_TaskTypes] ([Id]);


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_States_TaskTypeId]...';


GO
ALTER TABLE [dbo].[TM_States]
    ADD CONSTRAINT [FK_TM_States_TaskTypeId] FOREIGN KEY ([TaskTypeId]) REFERENCES [dbo].[TM_TaskTypes] ([Id]);


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_TaskTypeFieldMap_TaskTypeId]...';


GO
ALTER TABLE [dbo].[TM_TaskTypeFieldMap]
    ADD CONSTRAINT [FK_TM_TaskTypeFieldMap_TaskTypeId] FOREIGN KEY ([TaskTypeId]) REFERENCES [dbo].[TM_TaskTypes] ([Id]) ON DELETE CASCADE;


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_TaskTypeFieldMap_FieldId]...';


GO
ALTER TABLE [dbo].[TM_TaskTypeFieldMap]
    ADD CONSTRAINT [FK_TM_TaskTypeFieldMap_FieldId] FOREIGN KEY ([FieldId]) REFERENCES [dbo].[TM_Fields] ([Id]) ON DELETE CASCADE;


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_Transitions_FromStateId]...';


GO
ALTER TABLE [dbo].[TM_Transitions]
    ADD CONSTRAINT [FK_TM_Transitions_FromStateId] FOREIGN KEY ([FromStateId]) REFERENCES [dbo].[TM_States] ([Id]);


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_Transitions_ToStateId]...';


GO
ALTER TABLE [dbo].[TM_Transitions]
    ADD CONSTRAINT [FK_TM_Transitions_ToStateId] FOREIGN KEY ([ToStateId]) REFERENCES [dbo].[TM_States] ([Id]);


GO
PRINT N'Creating Foreign Key [dbo].[FK_TM_ValueLists_ParentId]...';


GO
ALTER TABLE [dbo].[TM_ValueLists]
    ADD CONSTRAINT [FK_TM_ValueLists_ParentId] FOREIGN KEY ([ParentId]) REFERENCES [dbo].[TM_ValueLists] ([Id]);


GO
PRINT N'Creating Trigger [dbo].[Trigger_TM_Queries_Del]...';


GO

CREATE TRIGGER [dbo].[Trigger_TM_Queries_Del]
    ON [dbo].[TM_Queries]
    INSTEAD OF DELETE
    AS
    BEGIN
        CREATE TABLE #T(
			Id    INT
		)
		INSERT INTO #T (Id)
		SELECT  Id
		FROM    deleted

		DECLARE @c INT
		SET @c = 0

		WHILE @c <> (SELECT COUNT(Id) FROM #T) BEGIN
        SELECT @c = COUNT(Id) FROM #T

        INSERT INTO #T (Id)
        SELECT  Q.Id
        FROM    [dbo].[TM_Queries] AS Q
        LEFT OUTER JOIN #T ON Q.Id = #T.Id
        WHERE   Q.ParentId IN (SELECT Id FROM #T)
        AND     #T.Id IS NULL
    END

    DELETE  [dbo].[TM_Queries]
    FROM    [dbo].[TM_Queries]
    INNER JOIN #T ON [dbo].[TM_Queries].Id = #T.Id
END
GO
PRINT N'Creating Trigger [dbo].[Trigger_TM_TaskEntities_Del]...';


GO

CREATE TRIGGER [dbo].[Trigger_TM_TaskEntities_Del]
	ON [dbo].[TM_TaskEntities]
	INSTEAD OF DELETE
AS
BEGIN
	SET NoCount ON
    DELETE  T FROM [dbo].[TM_TaskLinks] T INNER JOIN deleted D ON D.Id = T.SourceTaskId
	DELETE  T FROM [dbo].[TM_TaskLinks] T INNER JOIN deleted D ON D.Id = T.TargetTaskId
    DELETE  T FROM [dbo].[TM_TaskEntities] T INNER JOIN deleted D ON D.Id = T.Id
END
GO
PRINT N'Creating Trigger [dbo].[Trigger_TM_ValueList_Del]...';


GO

CREATE TRIGGER [dbo].[Trigger_TM_ValueList_Del]
    ON [dbo].[TM_ValueLists]
    INSTEAD OF DELETE
AS
BEGIN
	SET NoCount ON
	DELETE  FROM [dbo].[TM_ValueLists] WHERE ParentId IN (SELECT Id FROM deleted)
	DELETE  FROM [dbo].[TM_ValueLists] WHERE Id IN (SELECT Id FROM deleted)
END
GO
-- Refactoring step to update target server with deployed transaction logs

IF OBJECT_ID(N'dbo.__RefactorLog') IS NULL
BEGIN
    CREATE TABLE [dbo].[__RefactorLog] (OperationKey UNIQUEIDENTIFIER NOT NULL PRIMARY KEY)
    EXEC sp_addextendedproperty N'microsoft_database_tools_support', N'refactoring log', N'schema', N'dbo', N'table', N'__RefactorLog'
END
GO
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '5ec21828-bd2e-4acb-a560-3c250fa3742e')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('5ec21828-bd2e-4acb-a560-3c250fa3742e')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '1cc34cea-816f-4efd-85dc-1e1ac837bcfa')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('1cc34cea-816f-4efd-85dc-1e1ac837bcfa')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = 'c7c142f2-1832-4ada-bd2b-b3e41c75b966')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('c7c142f2-1832-4ada-bd2b-b3e41c75b966')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = 'd601d769-64c3-4922-ba13-ff549a991d33')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('d601d769-64c3-4922-ba13-ff549a991d33')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '67839e8b-0e27-48e7-aa58-959fab3c097c')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('67839e8b-0e27-48e7-aa58-959fab3c097c')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '5505a89e-b2ab-41c0-93ae-128fadbf32c1')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('5505a89e-b2ab-41c0-93ae-128fadbf32c1')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = 'd34436e5-452a-4eb3-8817-a9888c14c4e4')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('d34436e5-452a-4eb3-8817-a9888c14c4e4')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = 'a4f3f728-c3b7-4290-92ef-3d4e6fead332')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('a4f3f728-c3b7-4290-92ef-3d4e6fead332')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = 'e1488b2a-2298-42dd-adf6-1f8dc84cbae5')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('e1488b2a-2298-42dd-adf6-1f8dc84cbae5')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = 'd62b70bb-06cd-4f61-bec0-2f1eb250c82c')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('d62b70bb-06cd-4f61-bec0-2f1eb250c82c')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '9ff2cc3a-23b0-4a7c-bb1e-307a9ac50640')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('9ff2cc3a-23b0-4a7c-bb1e-307a9ac50640')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '2c6c3fb3-8f6f-4635-ac2d-88cb710ebd44')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('2c6c3fb3-8f6f-4635-ac2d-88cb710ebd44')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '31ef3d1c-6773-410b-8a09-3d7dec4b5aa5')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('31ef3d1c-6773-410b-8a09-3d7dec4b5aa5')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '9f0d6ac7-3a14-4186-b3bc-8071f7f15d91')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('9f0d6ac7-3a14-4186-b3bc-8071f7f15d91')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '42a64b52-81b9-40a0-9712-2c9092b0e523')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('42a64b52-81b9-40a0-9712-2c9092b0e523')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '9b5a177e-8c6a-4616-8726-4ef68d93d871')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('9b5a177e-8c6a-4616-8726-4ef68d93d871')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '4f6b0934-0e29-4537-ae59-81419ebad06b')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('4f6b0934-0e29-4537-ae59-81419ebad06b')
IF NOT EXISTS (SELECT OperationKey FROM [dbo].[__RefactorLog] WHERE OperationKey = '5ad2bf37-cac0-4189-878c-4d4fe12fe028')
INSERT INTO [dbo].[__RefactorLog] (OperationKey) values ('5ad2bf37-cac0-4189-878c-4d4fe12fe028')

GO

GO
/*
Post-Deployment Script Template							
--------------------------------------------------------------------------------------
 This file contains SQL statements that will be appended to the build script.		
 Use SQLCMD syntax to include a file in the post-deployment script.			
 Example:      :r .\myfile.sql								
 Use SQLCMD syntax to reference a variable in the post-deployment script.		
 Example:      :setvar TableName MyTable							
               SELECT * FROM [$(TableName)]					
--------------------------------------------------------------------------------------
*/

BEGIN TRANSACTION
	IF EXISTS (SELECT TOP 1 * FROM dbo.TM_Version)
		DELETE FROM dbo.TM_Version

	INSERT INTO dbo.TM_Version (DatabaseVersionMajor, DatabaseVersionMinor, DatabaseVersionPatch) VALUES (2,4,0)
COMMIT TRANSACTION
SET IDENTITY_INSERT [dbo].[TM_Fields] ON;
GO

-- Merge Standard Fields
MERGE INTO [dbo].[TM_Fields] AS Target
USING (VALUES 
  (1, N'Id', N'Id', 2), -- 2 : Integer
  (2, N'Name', N'Name', 1), -- 1 : String
  (3, N'Label', N'Label',  1), 
  (4, N'TaskType', N'TaskType', 1),   
  (5, N'Description', N'Description', 1), 
  (6, N'State', N'State', 1), 
  (7, N'ChangedBy', N'ChangedBy', 7),   
  (8, N'ChangedDateTime', N'ChangedDateTime', 4),   
  (9, N'Priority', N'Priority', 2), 
  (10, N'CustomerId', N'CustomerId', 1), 
  (11, N'CreateDateTime', N'CreateDateTime', 4), -- 4 : DateTime
  (12, N'StartDateTime', N'StartDateTime', 4), -- 4 : DateTime
  (13, N'PlanStartDateTime', N'PlanStartDateTime', 4), 
  (14, N'EndDateTime', N'EndDateTime', 4), 
  (15, N'PlanEndDateTime', N'PlanEndDateTime', 4), 
  (16, N'Responsible', N'Responsible', 7), 
  (17, N'Deputy', N'Deputy', 7), 
  (18, N'Creator', N'Creator', 7), 
  (19, N'Project', N'Project', 1),
  (20, N'Comment', N'Comment', 1),
  (21, N'Classification', N'Classification', 1),
  (22, N'CustomId', N'Custom Id', 1),
  (23, N'Completed', N'Completed', 0),
  (24, N'PercentComplete', N'Progress', 3),
  (25, N'Qualification', N'Qualification', 1),
  (26, N'EstimatedWorkingTime', N'Estimated WorkingTime', 3), 
  (27, N'AbsolvedWorkingTime', N'Absolved WorkingTime', 3),   
  (28, N'NotNecessary', N'Not Necessary', 0),
  (29, N'WorkExecution', N'Work Instruction', 6),
  (30, N'WorkInstruction', N'InstructionComment', 6),
  (31, N'Step', N'Step', 1),
  (32, N'ReferenceObject', N'ReferenceObject', 8),
  (33, N'Status', N'Status', 1),
  (34, N'DegreeOfCompletionHours', N'DegreeOfCompletionHours', 3),
  (35, N'DegreeOfCompletionActivities', N'DegreeOfCompletionActivities', 3),
  (37, N'ActualStartDateTime', N'ActualStartDateTime', 4),
  (38, N'Cancelled', N'Cancelled',	0),
  (39, N'Progress', N'Progress', 3),
  (40, N'AdditionalNecessary', N'AdditionalNecessary', 0),
  (42, N'Equipment', N'Equipment', 8),
  (43, N'Unit', N'Unit', 8),
  (44, N'TaskOwner', N'TaskOwner', 8),
  (46, N'MaintenancePlanObject', N'MaintenancePlanObject', 8),
  (47, N'Priorities', N'Priorities', 1),
  (48, N'CreatedByComos', N'CreatedByComos', 0),
  (49, N'EngineeringObject', N'EngineeringObject', 8),
  (50, N'Owner', N'Owner', 7),
  (51, N'AnnotationData', N'AnnotationData', 6),
  (52, N'ComosObjects', N'ComosObjects', 9),
  (53, N'DocumentNo', N'DocumentNo', 1),					
  (54, N'Subject', N'Subject', 1),
  (55, N'Keyword', N'Keyword', 1),
  (57, N'Role', N'Role', 1),
  (58, N'RequestForReject', N'RequestForReject', 1),
  (59, N'DocumentRevision', N'DocumentRevision', 8),
  (60, N'DueDate', N'DueDate', 4),
  (61, N'TaskCanceled', N'TaskCanceled', 0),
  (62, N'TaskClosed', N'TaskClosed', 0),
  (63, N'Accept', N'Accept', 0),
  (64, N'Reason', N'Reason', 1),
  (65, N'TaskCompleted', N'TaskCompleted', 0),
  (66, N'EditComment', N'EditComment', 6),
  (67, N'Reject', N'Reject', 0),
  (68, N'SignComment', N'SignComment', 1),
  (69, N'ReviewComments', N'ReviewComments', 6),
  (70, N'WorkflowInstanceId', N'WorkflowInstanceId', 1),
  (71, N'DocumentStatus', N'DocumentStatus', 1),
  (72, N'DocumentOwner', N'DocumentOwner', 7),
  (73, N'ComosTaskID', N'ComosTaskID', 2),
  (74, N'KindOfDocument', N'KindOfDocument', 1)
  )  
AS Source (Id, Name, DisplayName, Type) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET Name = Source.Name, DisplayName = Source.DisplayName, Type = Source.Type 
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT (Id, Name, DisplayName, Type) 
VALUES (Id, Name, DisplayName, Type) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;
GO

SET IDENTITY_INSERT [dbo].[TM_Fields] OFF;
GO
SET IDENTITY_INSERT [dbo].[TM_TaskTypes] ON;
GO

-- Reference Data for TM_TaskType 
MERGE INTO [dbo].[TM_TaskTypes] AS Target
USING (VALUES   
  (1, N'General Task', N'General Task', 1, NULL),
  (2, N'MRO Activity', N'MRO Activity', 2, N'M60.A160.A010'), 
  (3, N'MRO Workpackage', N'MRO Workpackage', 3, NULL)  , 
  (4, N'Mobile Operations Workpackage', N'Mobile Operations Workpackage', 4, NULL), 
  (5, N'Mobile Operations Activity', N'Mobile Operations Activity', 5, NULL),
  (6, N'Mobile Operations Event', N'Mobile Operations Event', 6, NULL),
  (7, N'Annotation', N'Redlining Task', 7, NULL),
  (8, N'DDMS Workflow Task', N'DDMS Workflow Task', 8, N'M01.A010'),
  (9, N'DDMS Consolidate Workflow Task', N'DDMS Consolidate Workflow Task', 9, N'M01.A010'),
  (10, N'DDMS Final Approver Workflow Task', N'DDMS Final Approver Workflow Task', 10, N'M01.A010')
) 
AS Source (Id, Name, Description, LayoutId, ComosClassification) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET Name = Source.Name 
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT (Id, Name, Description, LayoutId, ComosClassification) 
VALUES (Id, Name, Description, LayoutId, ComosClassification) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;

GO

SET IDENTITY_INSERT [dbo].[TM_TaskTypes] OFF;
GO

SET IDENTITY_INSERT [dbo].[TM_XmlProperties] ON;
GO
MERGE INTO [dbo].[TM_XmlProperties] AS Target
USING (VALUES   
  (1, N'General Task', N'<TaskLayout Version="1.0.0" xmlns=""><FlexContainer Orientation="Vertical" Wrap="false" Grow="1"><FlexContainer><Text FieldName="Id" IsEnabled="false"><Title>ID</Title></Text><Text IsMandatory="true" Grow="1" FieldName="Name"><Title>Title</Title></Text></FlexContainer><FlexContainer><State><Title>State</Title></State><Person IsEnabled="false" FieldName="Creator"><Title>Created By</Title></Person><FlexContainer><Datetime IsEnabled="false" FieldName="CreateDateTime"><Title>Creation date</Title></Datetime><Text IsEnabled="false" FieldName="TaskType"><Title>Type</Title></Text></FlexContainer></FlexContainer><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>General information</Title><FlexContainer Orientation="Vertical"><Group><Title>Task details</Title><FlexContainer AlignContent="Spread"><FlexContainer Orientation="Vertical"><Person FieldName="Responsible" MinWidth="300"><Title>Responsible</Title></Person><Datetime FieldName="PlanEndDateTime" MinWidth="300"><Title>Due Date</Title></Datetime></FlexContainer><FlexContainer Orientation="Vertical"><Dropdown FieldName="Priority" IsMandatory="true"><Title>Priority</Title></Dropdown><Project FieldName="Project"><Title>Project</Title></Project></FlexContainer></FlexContainer></Group><Group><Title>Related COMOS objects</Title><ComosReference FieldName="ReferenceObject" Grow="1"><Title>Reference Object</Title></ComosReference><ComosReferences Grow="1"><Title>Objects</Title></ComosReferences></Group></FlexContainer></Tab><Tab><Title>Work description</Title><Group Grow="1"><Title>Work instruction</Title><Text IsMultiline="true" FieldName="WorkInstruction" Grow="1"><Title>Description</Title></Text></Group><Group Grow="1"><Title>Work execution</Title><Text IsMultiline="true" FieldName="WorkExecution" Grow="1"><Title>Description</Title></Text></Group></Tab><Tab><Title>Attachments</Title><Attachments Grow="1" /></Tab><Tab><Title>History</Title><History Grow="1" /></Tab><Tab><Title>Links</Title><Links Grow="1" /></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>'),
  (2, N'MRO Activity', N'<TaskLayout Version="1.0.0" xmlns=""><FlexContainer Orientation="Vertical" Wrap="false" Grow="1"><FlexContainer><Text FieldName="Id" IsEnabled="false"><Title>ID</Title></Text><Text IsMandatory="true" Grow="1" FieldName="Name"><Title>Title</Title></Text></FlexContainer><FlexContainer><FlexContainer><FlexContainer Orientation="Vertical"><Checkbox FieldName="Completed"><Title>Completed</Title></Checkbox><Checkbox FieldName="NotNecessary"><Title>Not necessary</Title></Checkbox></FlexContainer><FlexContainer><Numeric FieldName="AbsolvedWorkingTime"><Title>Absolved working time</Title></Numeric><Numeric FieldName="PercentComplete"><Title>Progress</Title></Numeric><Person IsEnabled="false" FieldName="Creator"><Title>Created By</Title></Person></FlexContainer></FlexContainer><FlexContainer><Datetime IsEnabled="false" FieldName="CreateDateTime"><Title>Creation date</Title></Datetime><Text IsEnabled="false" FieldName="TaskType"><Title>Type</Title></Text></FlexContainer></FlexContainer><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>General information</Title><FlexContainer Orientation="Vertical"><Group><Title>Task details</Title><FlexContainer Orientation="Vertical"><Person FieldName="Responsible" MinWidth="300"><Title>Responsible</Title></Person><Project FieldName="Project" MinWidth="300"><Title>Project</Title></Project></FlexContainer></Group><Group><Title>Planning</Title><FlexContainer><FlexContainer Orientation="Vertical"><Datetime FieldName="PlanStartDateTime"><Title>Planned start date</Title></Datetime><Datetime FieldName="PlanEndDateTime"><Title>Planned end date</Title></Datetime></FlexContainer><Numeric FieldName="EstimatedWorkingTime"><Title>Estimated working time</Title></Numeric></FlexContainer></Group><Group><Title>Related COMOS objects</Title><ComosReferences Grow="1"><Title>Objects</Title></ComosReferences></Group></FlexContainer></Tab><Tab><Title>Work description</Title><Group Grow="1"><Title>Work instruction</Title><Text IsMultiline="true" FieldName="WorkInstruction" Grow="1"><Title>Description</Title></Text></Group><Group Grow="1"><Title>Work execution</Title><Text IsMultiline="true" FieldName="WorkExecution" Grow="1"><Title>Description</Title></Text></Group></Tab><Tab><Title>Attachments</Title><Attachments Grow="1" /></Tab><Tab><Title>History</Title><History Grow="1" /></Tab><Tab><Title>Links</Title><Links Grow="1" /></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>'),
  (3, N'MRO Workpackage', N'<TaskLayout Version="1.0.0" xmlns=""><FlexContainer Orientation="Vertical" Wrap="false" Grow="1"><FlexContainer><Text FieldName="Id" IsEnabled="false"><Title>ID</Title></Text><Text IsMandatory="true" Grow="1" FieldName="Name"><Title>Title</Title></Text></FlexContainer><FlexContainer><FlexContainer><State FieldName="State"><Title>State</Title></State><Numeric FieldName="AbsolvedWorkingTime"><Title>Absolved working time</Title></Numeric><Person IsEnabled="false" FieldName="Creator"><Title>Created By</Title></Person></FlexContainer><FlexContainer><Datetime IsEnabled="false" FieldName="CreateDateTime"><Title>Creation date</Title></Datetime><Text IsEnabled="false" FieldName="TaskType"><Title>Type</Title></Text></FlexContainer></FlexContainer><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>General information</Title><FlexContainer Orientation="Vertical"><Group><Title>Task details</Title><FlexContainer AlignContent="Spread"><Person FieldName="Responsible" MinWidth="300"><Title>Responsible</Title></Person><FlexContainer Orientation="Vertical"><Text IsEnabled="false" FieldName="Classification"><Title>Task classification</Title></Text><Text IsEnabled="false" FieldName="Priority"><Title>Task priority</Title></Text></FlexContainer></FlexContainer><Text IsMultiline="true" FieldName="Description" Grow="1"><Title>Task description</Title></Text><FlexContainer><Project IsEnabled="false" FieldName="Project" MinWidth="300"><Title>Project</Title></Project><Text FieldName="CustomerId"><Title>Customer</Title></Text></FlexContainer></Group><Group><Title>Planning</Title><FlexContainer><FlexContainer Orientation="Vertical"><Datetime FieldName="PlanStartDateTime"><Title>Planned start date</Title></Datetime><Datetime FieldName="PlanEndDateTime"><Title>Planned end date</Title></Datetime></FlexContainer><Numeric FieldName="EstimatedWorkingTime"><Title>Estimated working time</Title></Numeric></FlexContainer></Group><Group><Title>Related COMOS objects</Title><ComosReferences Grow="1"><Title>Objects</Title></ComosReferences></Group></FlexContainer></Tab><Tab><Title>Attachments</Title><Attachments Grow="1" /></Tab><Tab><Title>History</Title><History Grow="1" /></Tab><Tab><Title>Links</Title><Links Grow="1" /></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>'), 
  (4, N'Mobile Operations Workpackage', N'<TaskLayout Version="1.0.0" xmlns=""><FlexContainer Orientation="Vertical" Wrap="false" Grow="1"><FlexContainer><Text IsMandatory="true" Grow="1" FieldName="Name"><Title>Title<Translation Language="en">Title</Translation><Translation Language="de">Titel</Translation><Translation Language="cn">标题</Translation></Title></Text></FlexContainer><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>Details<Translation Language="en">Details</Translation><Translation Language="de">Details</Translation><Translation Language="cn">详细信息</Translation></Title><FlexContainer Orientation="Vertical"><Group><Title>Task details<Translation Language="de">Aufgaben Details</Translation><Translation Language="en">Task details</Translation><Translation Language="cn">任务信息</Translation></Title><FlexContainer><Person FieldName="Responsible" MinWidth="300"><Title>Responsible<Translation Language="en">Responsible</Translation><Translation Language="de">Verantwortlich</Translation><Translation Language="cn">责任</Translation></Title></Person><Dropdown FieldName="Status" MinWidth="200"><Title>State Workpackage<Translation Language="de">Status</Translation><Translation Language="en">Status</Translation><Translation Language="cn">状态</Translation></Title></Dropdown></FlexContainer><Text IsMultiline="true" FieldName="Description" Grow="1"><Title>Task description<Translation Language="de">Aufgabenbeschreibung</Translation><Translation Language="en">Task description</Translation><Translation Language="cn">任务描述</Translation></Title></Text><FlexContainer><Checkbox IsEnabled="false" FieldName="Cancelled"><Title>Cancelled<Translation Language="de">Storniert</Translation><Translation Language="en">Cancelled</Translation><Translation Language="cn">已取消</Translation></Title></Checkbox></FlexContainer></Group><Group><Title>Planning<Translation Language="de">Planung</Translation><Translation Language="en">Planning</Translation><Translation Language="cn">工程‹</Translation></Title><FlexContainer><FlexContainer Orientation="Vertical"><Datetime IsEnabled="false" FieldName="PlanStartDateTime"><Title>Planned start date<Translation Language="de">Geplantes Startdatum</Translation><Translation Language="en">Planned start date</Translation><Translation Language="cn">计划开始日期</Translation></Title></Datetime><Datetime IsEnabled="false" FieldName="ActualStartDateTime"><Title>Actual start date<Translation Language="de">IST Datum</Translation><Translation Language="en">Actual start date</Translation><Translation Language="cn">实际日期</Translation></Title></Datetime></FlexContainer><FlexContainer Orientation="Vertical"><Datetime IsEnabled="false" FieldName="PlanEndDateTime"><Title>Planned end date<Translation Language="de">Geplantes Enddatum</Translation><Translation Language="en">Planned end date</Translation><Translation Language="cn">计划结束日期</Translation></Title></Datetime><Numeric IsEnabled="false" FieldName="EstimatedWorkingTime"><Title>Estimated working time<Translation Language="de">Geplante Arbeitseinheiten</Translation><Translation Language="en">Planned working units</Translation><Translation Language="cn">计划工作单位</Translation></Title></Numeric></FlexContainer></FlexContainer></Group></FlexContainer></Tab><Tab><Title>Activities<Translation Language="de">Aktivitäten</Translation><Translation Language="en">Activities</Translation><Translation Language="cn">活动</Translation></Title><Links Grow="1" /></Tab><Tab><Title>Related Objects<Translation Language="de">verknüpfte Objekte</Translation><Translation Language="en">Related Objects</Translation><Translation Language="cn">关联对象</Translation></Title><ComosReference FieldName="MaintenancePlanObject" Grow="1"><Title>Maintainance Plan<Translation Language="en">Maintainance Plan</Translation><Translation Language="de">Wartungsplanobjekt</Translation><Translation Language="cn">链接到维护计划对象</Translation></Title></ComosReference><ComosReference FieldName="Equipment" Grow="1"><Title>Equipment<Translation Language="en">Equipment</Translation><Translation Language="de">Equipment</Translation><Translation Language="cn">装置</Translation></Title></ComosReference><ComosReference FieldName="Unit" Grow="1"><Title>Unit<Translation Language="en">Unit</Translation><Translation Language="de">Anlage</Translation><Translation Language="cn">单元</Translation></Title></ComosReference><ComosReference FieldName="EngineeringObject" Grow="1"><Title>EngineeringObject<Translation Language="en">Engineering Object</Translation><Translation Language="de">Planungsobjekt</Translation><Translation Language="cn">工程对象</Translation></Title></ComosReference></Tab><Tab><Title>Attachments<Translation Language="de">Anhänge</Translation><Translation Language="en">Attachments</Translation><Translation Language="cn">附件</Translation></Title><Attachments Grow="1" /></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>'),
  (5, N'Mobile Operations Activity', N'<TaskLayout Version="1.0.0" xmlns=""><FlexContainer Orientation="Vertical" Wrap="false" Grow="1"><Text Grow="1" FieldName="Description"><Title>Description<Translation Language="de">Beschreibung</Translation><Translation Language="en">Description</Translation><Translation Language="cn">描述</Translation></Title></Text><Text IsMultiline="true" FieldName="WorkInstruction" Grow="1"><Title>Work Instruction<Translation Language="de">Arbeitsanweisung</Translation><Translation Language="en">Work Instruction</Translation><Translation Language="cn">工作说明</Translation></Title></Text><Numeric IsEnabled="false" FieldName="PercentComplete"><Title>Progress (%)<Translation Language="de">Fortschritt (%)</Translation><Translation Language="en">Progress (%)</Translation><Translation Language="cn">进度 (%)</Translation></Title></Numeric><Checkbox IsEnabled="false" FieldName="Completed"><Title>Completed<Translation Language="de">Abgeschlossen</Translation><Translation Language="en">Completed</Translation><Translation Language="cn">已完成</Translation></Title></Checkbox><Checkbox IsEnabled="false" FieldName="NotNecessary"><Title>Not necessary<Translation Language="de">Nicht notwendig</Translation><Translation Language="en">Not necessary</Translation><Translation Language="cn">不需要</Translation></Title></Checkbox><Checkbox FieldName="AdditionalNecessary"><Title>Additional necessary<Translation Language="de">Zusätzlich notwendig</Translation><Translation Language="en">Additional necessary</Translation><Translation Language="cn">另有需要</Translation></Title></Checkbox><Text IsMultiline="true" FieldName="WorkExecution" Grow="1"><Title>Work Execution<Translation Language="de">Arbeitsdurchführung</Translation><Translation Language="en">Work Execution</Translation><Translation Language="cn">工作执行</Translation></Title></Text><Assigne Grow="1" MinWidth="200"><Title>Assign Resource<Translation Language="de">Assign Resource</Translation><Translation Language="en">Assign Resource</Translation><Translation Language="cn">分配资源</Translation></Title></Assigne></FlexContainer></TaskLayout>'),
  (6, N'Mobile Operations Event', N'<TaskLayout Version="1.0.0" xmlns=""><FlexContainer Orientation="Vertical" Wrap="false" Grow="1"><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>Details<Translation Language="en">Details</Translation><Translation Language="de">Details</Translation><Translation Language="cn">详细信息</Translation></Title><FlexContainer Orientation="Vertical"><Group><Title>General<Translation Language="en">General</Translation><Translation Language="de">General</Translation><Translation Language="cn">General</Translation></Title><FlexContainer><FlexContainer><Dropdown FieldName="Priorities"><Title>Priority<Translation Language="en">Priority</Translation><Translation Language="de">Priorität</Translation><Translation Language="cn">优先级</Translation></Title></Dropdown><Dropdown FieldName="Status"><Title>Status<Translation Language="de">Status</Translation><Translation Language="en">Status</Translation><Translation Language="cn">状态</Translation></Title></Dropdown><Datetime IsEnabled="false" FieldName="CreateDateTime"><Title>Creation date<Translation Language="de">Erstelldatum</Translation><Translation Language="en">Creation date</Translation><Translation Language="cn">创建日期</Translation></Title></Datetime><Person IsEnabled="false" FieldName="Creator"><Title>Created By<Translation Language="de">Erstellt von</Translation><Translation Language="en">Created By</Translation><Translation Language="cn">创建者</Translation></Title></Person></FlexContainer><FlexContainer></FlexContainer></FlexContainer><Text IsMultiline="true" FieldName="Description" Grow="1"><Title>Description<Translation Language="de">Beschreibung</Translation><Translation Language="en">Description</Translation><Translation Language="cn">描述</Translation></Title></Text><FlexContainer AlignContent="Spread"><Person FieldName="Responsible" MinWidth="300"><Title>Responsible<Translation Language="en">Responsible</Translation><Translation Language="de">Verantwortlich</Translation><Translation Language="cn">责任</Translation></Title></Person></FlexContainer></Group></FlexContainer></Tab><Tab><Title>Related Objects<Translation Language="de">verknüpfte Objekte</Translation><Translation Language="en">Related Objects</Translation><Translation Language="cn">关联对象</Translation></Title><ComosReference Grow="1" FieldName="TaskOwner"><Title>Equipment<Translation Language="en">Equipment</Translation><Translation Language="de">Equipment</Translation><Translation Language="cn">装置</Translation></Title></ComosReference></Tab><Tab><Title>Attachments<Translation Language="de">Anhänge</Translation><Translation Language="en">Attachments</Translation><Translation Language="cn">附件</Translation></Title><Attachments Grow="1" /></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>'),
  (7, N'Redlining Task', N'<TaskLayout xmlns="" Version="1.0.0"><FlexContainer Grow="1" Orientation="Vertical" Wrap="false"><FlexContainer><Text IsEnabled="false" FieldName="Id" MinWidth="150"><Title>ID</Title></Text><State MinWidth="150"><Title>State</Title></State><Person IsEnabled="false" FieldName="Creator" MinWidth="150"><Title>Created By</Title></Person><Person FieldName="Responsible" MinWidth="150"><Title>Responsible</Title></Person></FlexContainer><FlexContainer><Datetime IsEnabled="false" FieldName="CreateDateTime" MinWidth="150"><Title>Creation date</Title></Datetime><Datetime IsEnabled="false" FieldName="ChangedDateTime" MinWidth="150"><Title>Change date</Title></Datetime><Text IsEnabled="false" FieldName="TaskType" MinWidth="150"><Title>Type</Title></Text></FlexContainer><FlexContainer Grow="1" Orientation="Vertical"><Group><Title>Related COMOS objects</Title><ComosReference Grow="1" FieldName="ReferenceObject" MinWidth="150" HideEditingButtons="true"><Title>Comos Document</Title><Buttons /></ComosReference><ComosReferences Grow="1" FieldName="ComosObjects" MinWidth="150" HideEditingButtons="true"><Title>Comos Objects</Title><Buttons /></ComosReferences></Group></FlexContainer></FlexContainer></TaskLayout>'),
  (8, N'DDMS Workflow Task', N'<TaskLayout xmlns="" Version="1.0.0"><FlexContainer Grow="1" Orientation="Vertical" Wrap="false"><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="Name" MinWidth="500" IsMandatory="true"><Title>Task description:<Translation Language="de">Aufgaben-Beschreibung:</Translation></Title></Text><Text IsEnabled="false" FieldName="ComosTaskID" MinWidth="150"><Title>Task ID:<Translation Language="de">Aufgaben-ID:</Translation></Title></Text></FlexContainer><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>Document information<Translation Language="de">Dokument Information</Translation></Title><FlexContainer Orientation="Vertical"><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="DocumentNo" MinWidth="150"><Title>Document No. / revision<Translation Language="de">Dokumenten-Nr. / Revision</Translation></Title></Text><Text Grow="1" IsEnabled="false" FieldName="Description" MinWidth="150"><Title>Description<Translation Language="de">Beschreibung</Translation></Title></Text></FlexContainer><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="KindOfDocument" MinWidth="150"><Title>Kind of document<Translation Language="de">Dokumentenart</Translation></Title></Text><Text Grow="1" IsEnabled="false" FieldName="DocumentStatus" MinWidth="150"><Title>Document status<Translation Language="de">Dokumentenstatus</Translation></Title></Text></FlexContainer><Tabs Grow="1"><Tab><Title>Task information<Translation Language="de">Aufgaben Information</Translation></Title><FlexContainer AlignContent="Spread"><FlexContainer><Person IsEnabled="false" FieldName="Responsible" MinWidth="300"><Title>Assigned user<Translation Language="de">Zugewiesener Benutzer</Translation></Title></Person><Text IsEnabled="false" FieldName="Reason" MinWidth="380"><Title>Signature reason<Translation Language="de">Grund der Signatur</Translation></Title></Text><Datetime IsEnabled="false" FieldName="PlanEndDateTime" MinWidth="120"><Title>Due date<Translation Language="de">Fälligkeitsdatum</Translation></Title></Datetime><Person IsEnabled="false" FieldName="DocumentOwner" MinWidth="300"><Title>Document owner<Translation Language="de">Eigentümer des Dokuments</Translation></Title></Person></FlexContainer></FlexContainer><FlexContainer><Text Grow="1" FieldName="EditComment" MinWidth="150" IsMandatory="true" IsMultiline="true"><Title>My comment<Translation Language="de">Mein Kommentar</Translation><Translation Language="cn" /></Title></Text></FlexContainer><ComosReference Grow="1" FieldName="DocumentRevision" MinWidth="150"><Title>Related document revision<Translation Language="de">Zugehörige Dokumenten-Revision</Translation><Translation Language="en" /><Translation Language="cn" /></Title><Buttons><Button MinWidth="150" ForegroundColor="#fff" BackgroundColor="#0e777c" MinHeight="50" Action="AcceptRevision" IsDisabled="@Fields.Accept"><Title>Accept<Translation Language="en">Accept</Translation><Translation Language="de">Akzeptieren</Translation></Title><ActionContext><Item Name="TaskId" Value="@Fields.Id" /><Item Name="Revision" Value="@Fields.DocumentRevision" /><Item Name="ReasonVar" Value="@Fields.Reason" /></ActionContext></Button><Button MinWidth="150" ForegroundColor="#1a1c1e" BackgroundColor="#becdd9" MinHeight="50" Action="RejectRevision" IsDisabled="@Fields.Reject"><Title>Reject<Translation Language="en">Reject</Translation><Translation Language="de">Ablehnen</Translation></Title><ActionContext><Item Name="TaskId" Value="@Fields.Id" /></ActionContext></Button></Buttons><ComosReferenceOptions HideEditingButtons="true" /></ComosReference></Tab></Tabs></FlexContainer></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>'),
  (9, N'DDMS Consolidate Workflow Task', N'<TaskLayout xmlns="" Version="1.0.0"><FlexContainer Grow="1" Orientation="Vertical" Wrap="false"><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="Name" MinWidth="450" IsMandatory="true"><Title>Task description:<Translation Language="de">Aufgaben-Beschreibung:</Translation><Translation Language="cn" /></Title></Text><Text IsEnabled="false" FieldName="ComosTaskID" MinWidth="150"><Title>Task ID:<Translation Language="de">Aufgaben-ID:</Translation></Title></Text></FlexContainer><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>Document information<Translation Language="de">Dokumenten-Information</Translation></Title><FlexContainer Orientation="Vertical"><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="DocumentNo" MinWidth="150"><Title>Document No. / revision<Translation Language="de">Dokumenten-Nr. / Revision</Translation><Translation Language="cn" /></Title></Text><Text Grow="1" IsEnabled="false" FieldName="Description" MinWidth="150"><Title>Description<Translation Language="de">Beschreibung</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text></FlexContainer><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="KindOfDocument" MinWidth="150"><Title>Kind of document<Translation Language="de">Dokumentenart</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text><Text Grow="1" IsEnabled="false" FieldName="DocumentStatus" MinWidth="150"><Title>Document status<Translation Language="de">Dokumentenstatus</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text></FlexContainer><Tabs Grow="1"><Tab><Title>Task information<Translation Language="de">Aufgaben Information</Translation></Title><FlexContainer AlignContent="Spread"><FlexContainer><Person IsEnabled="false" FieldName="Responsible" MinWidth="300"><Title>Assigned User<Translation Language="de">Zugewiesener Benutzer</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Person><Text IsEnabled="false" FieldName="Reason" MinWidth="380"><Title>Signature reason<Translation Language="de">Grund der Signatur</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text><Datetime IsEnabled="false" FieldName="PlanEndDateTime" MinWidth="120"><Title>Due Date<Translation Language="de">Fälligkeitsdatum</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Datetime><Person IsEnabled="false" FieldName="DocumentOwner" MinWidth="300"><Title>Document owner<Translation Language="de">Eigentümer des Dokuments</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Person></FlexContainer></FlexContainer><FlexContainer AlignContent="Spread"><Text Grow="1" IsEnabled="false" FieldName="ReviewComments" MinWidth="400" IsMultiline="true"><Title>Review comments<Translation Language="de">Kommentare zur Überprüfung</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text></FlexContainer><FlexContainer AlignContent="Spread"><Text Grow="1" FieldName="EditComment" MinWidth="300" IsMandatory="true" IsMultiline="true"><Title>My Comment<Translation Language="de">Mein Kommentar</Translation></Title></Text></FlexContainer><ComosReference Grow="1" FieldName="DocumentRevision" MinWidth="150"><Title>Related document revision<Translation Language="de">Zugehörige Dokumenten-Revision</Translation><Translation Language="en">Related document revision</Translation><Translation Language="cn" /></Title><Buttons><Button MinWidth="150" ForegroundColor="#fff" BackgroundColor="#0e777c" MinHeight="50" Action="AcceptConsolidation" IsDisabled="@Fields.Accept"><Title>Accept<Translation Language="en">Accept</Translation><Translation Language="de">Akzeptieren</Translation></Title><ActionContext><Item Name="TaskId" Value="@Fields.Id" /><Item Name="Revision" Value="@Fields.DocumentRevision" /><Item Name="ReasonVar" Value="@Fields.Reason" /></ActionContext></Button><Button MinWidth="150" ForegroundColor="#1a1c1e" BackgroundColor="#becdd9" MinHeight="50" Action="RejectConsolidation" IsDisabled="@Fields.Reject"><Title>Reject<Translation Language="en">Reject</Translation><Translation Language="de">Ablehnen</Translation></Title><ActionContext><Item Name="TaskId" Value="@Fields.Id" /></ActionContext></Button></Buttons><ComosReferenceOptions HideEditingButtons="true" /></ComosReference></Tab></Tabs></FlexContainer></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>'),
  (10, N'DDMS Final Approver Workflow Task', N'<TaskLayout xmlns="" Version="1.0.0"><FlexContainer Grow="1" Orientation="Vertical" Wrap="false"><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="Name" MinWidth="450" IsMandatory="true"><Title>Task description:<Translation Language="de">Aufgaben-Beschreibung:</Translation><Translation Language="cn" /></Title></Text><Text IsEnabled="false" FieldName="ComosTaskID" MinWidth="150"><Title>Task ID:<Translation Language="de">Aufgaben-ID:</Translation></Title></Text></FlexContainer><FlexContainer Grow="1"><Tabs Grow="1"><Tab><Title>Document information<Translation Language="de">Dokumenten-Information</Translation></Title><FlexContainer Orientation="Vertical"><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="DocumentNo" MinWidth="150"><Title>Document No. / revision<Translation Language="de">Dokumenten-Nr. / Revision</Translation><Translation Language="cn" /></Title></Text><Text Grow="1" IsEnabled="false" FieldName="Description" MinWidth="150"><Title>Description<Translation Language="de">Beschreibung</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text></FlexContainer><FlexContainer><Text Grow="1" IsEnabled="false" FieldName="KindOfDocument" MinWidth="150"><Title>Kind of document<Translation Language="de">Dokumentenart</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text><Text Grow="1" IsEnabled="false" FieldName="DocumentStatus" MinWidth="150"><Title>Document status<Translation Language="de">Dokumentenstatus</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text></FlexContainer><Tabs Grow="1"><Tab><Title>Task information<Translation Language="de">Aufgaben Information</Translation></Title><FlexContainer AlignContent="Spread"><FlexContainer><Person IsEnabled="false" FieldName="Responsible" MinWidth="300"><Title>Assigned User<Translation Language="de">Zugewiesener Benutzer</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Person><Text IsEnabled="false" FieldName="Reason" MinWidth="380"><Title>Signature reason<Translation Language="de">Grund der Signatur</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text><Datetime IsEnabled="false" FieldName="PlanEndDateTime" MinWidth="120"><Title>Due Date<Translation Language="de">Fälligkeitsdatum</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Datetime><Person IsEnabled="false" FieldName="DocumentOwner" MinWidth="300"><Title>Document owner<Translation Language="de">Eigentümer des Dokuments</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Person></FlexContainer></FlexContainer><FlexContainer AlignContent="Spread"><Text Grow="1" IsEnabled="false" FieldName="ReviewComments" MinWidth="400" IsMultiline="true"><Title>Review comments<Translation Language="de">Kommentare zur Überprüfung</Translation><Translation Language="en" /><Translation Language="cn" /></Title></Text></FlexContainer><FlexContainer AlignContent="Spread"><Text Grow="1" FieldName="EditComment" MinWidth="300" IsMandatory="true" IsMultiline="true"><Title>My Comment<Translation Language="de">Mein Kommentar</Translation></Title></Text></FlexContainer><ComosReference Grow="1" FieldName="DocumentRevision" MinWidth="150"><Title>Related document revision<Translation Language="de">Zugehörige Dokumenten-Revision</Translation><Translation Language="en">Related document revision</Translation><Translation Language="cn" /></Title><Buttons><Button MinWidth="150" ForegroundColor="#fff" BackgroundColor="#0e777c" MinHeight="50" Action="AcceptFinalApprover" IsDisabled="@Fields.Accept"><Title>Accept<Translation Language="en">Accept</Translation><Translation Language="de">Akzeptieren</Translation></Title><ActionContext><Item Name="TaskId" Value="@Fields.Id" /><Item Name="Revision" Value="@Fields.DocumentRevision" /><Item Name="ReasonVar" Value="@Fields.Reason" /></ActionContext></Button><Button MinWidth="150" ForegroundColor="#1a1c1e" BackgroundColor="#becdd9" MinHeight="50" Action="RejectConsolidation" IsDisabled="@Fields.Reject"><Title>Reject<Translation Language="en">Reject</Translation><Translation Language="de">Ablehnen</Translation></Title><ActionContext><Item Name="TaskId" Value="@Fields.Id" /></ActionContext></Button></Buttons><ComosReferenceOptions HideEditingButtons="true" /></ComosReference></Tab></Tabs></FlexContainer></Tab></Tabs></FlexContainer></FlexContainer></TaskLayout>')
) 
AS Source (Id, Name, Value) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET Name = Source.Name, Value = Source.Value 
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT (Id, Name, Value) 
VALUES (Id, Name, Value) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;

GO

SET IDENTITY_INSERT [dbo].[TM_XmlProperties] OFF;
GO

SET IDENTITY_INSERT [dbo].[TM_States] ON;
GO

-- Reference Data for TM_States
MERGE INTO [dbo].[TM_States] AS Target
USING (VALUES   
  (1, N'Created', 1),
  (2, N'OnWork', 1),
  (3, N'Completed', 1),
  (4, N'Created', 3),
  (5, N'OnWork', 3),
  (6, N'Completed', 3)
) 
AS Source (Id, Name, TaskTypeId) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET Name = Source.Name, TaskTypeId = Source.TaskTypeId 
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT (Id, Name, TaskTypeId) 
VALUES (Id, Name, TaskTypeId) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;

GO

SET IDENTITY_INSERT [dbo].[TM_States] OFF;
GO

SET IDENTITY_INSERT [dbo].[TM_Transitions] ON;
GO
-- Reference Data for TM_Transitions
MERGE INTO [dbo].[TM_Transitions] AS Target
USING (VALUES   
  (1, NULL, 1),
  (2, 1, 2),
  (3, 2, 3),
  (4, NULL, 4),
  (5, 4, 5),
  (6, 5, 6)
) 
AS Source (Id, FromStateId, ToStateId) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET FromStateId = Source.FromStateId, ToStateId = Source.ToStateId  
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT (Id, FromStateId, ToStateId) 
VALUES (Id, FromStateId, ToStateId) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;

GO

SET IDENTITY_INSERT [dbo].[TM_Transitions] OFF;
GO
SET IDENTITY_INSERT [dbo].[TM_TaskTypeFieldMap] ON;
GO
-- Create Tasktype to Fields map
MERGE INTO [dbo].[TM_TaskTypeFieldMap] AS Target
USING (VALUES 
  (1, 1, 1, NULL),
  (2, 1, 2, NULL), 
  (3, 1, 3, NULL),
  (4, 1, 4, NULL), 
  (5, 1, 5, NULL),
  (6, 1, 6, NULL), 
  (7, 1, 7, NULL),
  (8, 1, 8, NULL), 
  (9, 1, 9, NULL),
  (10, 1, 10, NULL),
  (11, 1, 11, NULL),
  (12, 1, 12, NULL),
  (13, 1, 13, NULL),
  (14, 1, 14, NULL),
  (15, 1, 15, NULL),
  (16, 1, 16, NULL),
  (17, 1, 17, NULL),
  (18, 1, 18, NULL),
  (19, 1, 19, NULL),
  (20, 1, 20, NULL),
  (21, 1, 21, NULL),
  (22, 1, 22, NULL),
  (23, 1, 29, NULL),
  (24, 1, 30, NULL),
  (25, 1, 31, NULL),
  (26, 1, 32, NULL),
  (27, 1, 50, NULL),
  (31, 2, 1, NULL),
  (32, 2, 2, NULL), 
  (33, 2, 3, NULL),
  (34, 2, 4, NULL), 
  (35, 2, 5, NULL),
  (36, 2, 6, NULL), 
  (37, 2, 7, NULL),
  (38, 2, 8, NULL), 
  (39, 2, 9, NULL),
  (40, 2, 10, NULL),
  (41, 2, 11, NULL),
  (42, 2, 12, NULL),
  (43, 2, 13, NULL),
  (44, 2, 14, NULL),
  (45, 2, 15, NULL),
  (46, 2, 16, NULL),
  (47, 2, 17, NULL),
  (48, 2, 18, NULL),
  (49, 2, 19, NULL),
  (50, 2, 20, N'Y00T00058.Y00A00647AA02'),
  (51, 2, 21, NULL),
  (52, 2, 22, N'Y00T00262.Y00A00736'),
  (53, 2, 23, N'Y00T00236.Y00A00738'),
  (54, 2, 24, N'Y00T00236.Y00A02885'),
  (55, 2, 25, N'Y00T00228.Y00A00747'),
  (56, 2, 26, NULL),
  (57, 2, 27, NULL),  
  (58, 2, 29, N'Y00T00239.Y00A02833'),
  (59, 2, 30, N'Y00T00238.Y00A02832'),  
  (60, 2, 28, NULL),
  (76, 3, 1, NULL),
  (77, 3, 2, NULL), 
  (78, 3, 3, NULL),
  (79, 3, 4, NULL), 
  (80, 3, 5, NULL),
  (81, 3, 6, NULL), 
  (82, 3, 7, NULL),
  (83, 3, 8, NULL), 
  (84, 3, 9, NULL),
  (85, 3, 10, NULL),
  (86, 3, 11, NULL),
  (87, 3, 12, NULL),
  (88, 3, 13, NULL),
  (89, 3, 14, NULL),
  (90, 3, 15, NULL),
  (91, 3, 16, NULL),
  (92, 3, 17, NULL),
  (93, 3, 18, NULL),
  (94, 3, 19, NULL),
  (95, 3, 20, NULL),
  (96, 3, 21, NULL),
  (97, 3, 22, NULL),
  (98, 3, 26, NULL),
  (99, 3, 27, NULL),  
  (100, 3, 29, NULL),
  (101, 3, 31, NULL),

  (110, 4, 1, NULL),
  (111, 4, 2, N'@Name'), 
  (112, 4, 3, N'@Label'), 
  (113, 4, 4, NULL), 
  (114, 4, 5, N'@Description'), 
  (115, 4, 11, NULL),
  (116, 4, 13, N'Y00T00235.Y00A02913'),
  (117, 4, 15, N'Y00T00235.Y00A02912'),
  (118, 4, 16, N'Y00T00233.Y00A03028AB'),
  (119, 4, 18, NULL),
  (120, 4, 26, N'Y00T00407.Y00A07369'),
  (121, 4, 7, NULL),
  (122, 4, 8, NULL),
  (123, 4, 34, N'Y00T00225.Y00A03042'),
  (124, 4, 35, N'Y00T00225.Y00A02801'),
  (126, 4, 37, N'Y00T00225.Y00A02827'),
  (127, 4, 38, N'Y00T00225.Y00A00726'),
  (128, 4, 33, N'Y00T00225.Y00A01088'),
  (129, 4, 42, N'Y00T00194.Y00A02331'), 
  (130, 4, 43, N'Y00T00194.Y00A00161'), 
  (131, 4, 46, N'Y00T00194.Y00A01123'),
  (132, 4, 6, NULL),  
  (134, 4, 48, N'Y00T00407.Y00A00916'),
  (135, 4, 49, NULL),
  
  (140, 5, 1, NULL), 
  (141, 5, 2, N'@Name'), 
  (142, 5, 3, N'@Label'), 
  (143, 5, 4, NULL), 
  (144, 5, 5, N'@Description'), 
  (145, 5, 6, NULL), 
  (146, 5, 7, NULL), 
  (147, 5, 8, NULL), 
  (148, 5, 10, NULL), 
  (149, 5, 11, NULL), 
  (150, 5, 16, N'Y00T00233.Y00A03028AB'), 
  (151, 5, 17, N'Y00T00233.Y00A03028AA02'), 
  (152, 5, 18, NULL), 
  (153, 5, 20, N'Y00T00058.Y00A00647AA02'), 
  (154, 5, 22, N'Y00T00262.Y00A00736'), 
  (155, 5, 23, N'Y00T00236.Y00A00738'), 
  (156, 5, 24, N'Y00T00236.Y00A02885'), 
  (157, 5, 25, N'Y00T00228.Y00A00747'), 
  (158, 5, 26, NULL), 
  (159, 5, 27, NULL), 
  (160, 5, 29, N'Y00T00239.Y00A02833'), 
  (161, 5, 30, N'Y00T00238.Y00A02832'), 
  (162, 5, 28, N'Y00T00236.Y00A02962'), 
  (163, 5, 40, N'Y00T00236.Y00A03045'), 
  (164, 5, 48, N'Y00T00407.Y00A00916'), 
  (165, 5, 13, N'Y00T00235.Y00A02913'), 
  (166, 5, 15, N'Y00T00235.Y00A02912'), 
  
  (170, 6, 1, NULL), 
  (171, 6, 2, N'@Name'), 
  (172, 6, 3, N'@Label'), 
  (173, 6, 4, NULL), 
  (174, 6, 5, N'@Description'), 
  (175, 6, 6, NULL), 
  (176, 6, 11, N'Y00T00250.Y00A00710'), 
  (177, 6, 13, NULL), 
  (179, 6, 16, N'Y00T00233.Y00A03028AB'), 
  (180, 6, 18, NULL), 
  (182, 6, 33, N'Y00T00250.Y00A01088'), 
  (183, 6, 47, N'Y00T00230.Y00A00679'),
  (185,	6, 44, N'@Script'),
  (186,	6, 48, N'Y00T00407.Y00A00916'),
  
  (190,	7, 1, NULL),
  (191,	7, 4, NULL),
  (192,	7, 6, NULL),
  (193,	7, 7, NULL),
  (194,	7, 8, NULL),
  (195,	7, 11, NULL),
  (196,	7, 16, NULL),
  (197,	7, 18, NULL),
  (198,	7, 32, NULL),
  (199,	7, 51, NULL),
  (200, 7, 52, NULL),
  
  (201, 8, 1, N'Y00T00001.Y00A07364'),
  (202, 8, 2, N'Y00T00032.Y00A01007'), 
  (203, 8, 3, NULL),
  (204, 8, 4, NULL),
  (205, 8, 5, N'Y00T00032.Y00A00175'),
  (206, 8, 6, N'Y00T00001.Y00A07361'),
  (207, 8, 11, NULL),
  (208, 8, 16, N'Y00T00001.Y00A00785'),
  (209, 8, 18, NULL),
  (210, 8, 13, NULL),
  (211, 8, 7, NULL),
  (212, 8, 8, NULL),
  (213, 8, 10, NULL),
  (214, 8, 17, NULL),
  (215, 8, 66, N'Y00T00032.Y00A00011'),
  (216, 8, 22, NULL),
  (217, 8, 23, NULL),
  (218, 8, 24, NULL),
  (219, 8, 25, NULL),
  (220, 8, 26, NULL),
  (221, 8, 27, NULL),
  (222, 8, 29, NULL),
  (223, 8, 30, NULL),
  (224, 8, 28, NULL),
  (225, 8, 15, N'Y00T00032.Y00A07342'),
  (226, 8, 53, N'Y00T00032.Y00A06001'),
  (227, 8, 54, N'Y00T00032.Y00A01054'),
  (229, 8, 9, NULL),
  (230, 8, 14, NULL),
  (231, 8, 19, NULL),
  (233, 8, 57, NULL),
  (234, 8, 63, N'Y00T00001.Y00A00764'),
  (235, 8, 58, NULL),
  (236, 8, 59, N'Y00T00001.Y00A00825'),
  (237, 8, 60, NULL),
  (238, 8, 33, N'Y00T00001.Y00A01088'),
  (239, 8, 61, N'Y00T00001.Y00A07363'),
  (240, 8, 62, N'Y00T00001.Y00A07360'),
  (241, 8, 21, NULL),		
  (242, 8, 64, N'Y00T00032.Y00A04953AA01'), 
  (244, 8, 12, N'Y00T00001.Y00A01090'),
  (299, 8, 71, N'Y00T00032.Y00A01088'),
  (300, 8, 72, N'Y00T00032.Y00A05615'),
  (303, 8, 67, N'Y00T00001.Y00A00764AA01'),
  (305, 8, 65, NULL),
  (306, 8, 73, N'Y00T00001.Y00A00736'),
  (307, 8, 74, N'Y00T00032.Y00A01557'),

  (255, 9, 1, N'Y00T00001.Y00A07364'),
  (256, 9, 2, N'Y00T00032.Y00A01007'),
  (257, 9, 4, NULL),
  (258, 9, 5, N'Y00T00032.Y00A00175'),
  (259, 9, 11, NULL),
  (260, 9, 18, NULL),
  (261, 9, 53, N'Y00T00032.Y00A06001'),
  (262, 9, 60, NULL),
  (263, 9, 54, N'Y00T00032.Y00A01054'),
  
  (265, 9, 3, NULL),
  (266, 9, 6, N'Y00T00001.Y00A07361'),
  (267, 9, 7, NULL),
  (268, 9, 8, NULL),
  (269, 9, 9, NULL),
  (270, 9, 10, NULL),
  (271, 9, 12, N'Y00T00001.Y00A01090'),
  (272, 9, 13, NULL),
  (273, 9, 14, NULL),
  (274, 9, 15, N'Y00T00032.Y00A07342'),
  (275, 9, 16, N'Y00T00001.Y00A00785'),
  (276, 9, 17, NULL),
  (277, 9, 19, NULL),
  (278, 9, 69, N'Y00T00032.Y00A00011AA01'),
  (279, 9, 22, NULL),
  (280, 9, 23, NULL),
  (281, 9, 24, NULL),
  (282, 9, 25, NULL),
  (283, 9, 26, NULL),
  (284, 9, 27, NULL),
  (285, 9, 29, NULL),
  (286, 9, 30, NULL),
  (287, 9, 28, NULL),
  (288, 9, 57, NULL),
  (289, 9, 59, N'Y00T00001.Y00A00825'),  
  (290, 9, 63, N'Y00T00001.Y00A00764'),
  (291, 9, 58, NULL),
  (292, 9, 61, N'Y00T00001.Y00A07363'),
  (293, 9, 62, N'Y00T00001.Y00A07360'),
  (294, 9, 64, N'Y00T00032.Y00A04953AA01'),
  (296, 9, 66, N'Y00T00032.Y00A00011'),
  (297, 9, 21, NULL),
  (301, 9, 71, N'Y00T00032.Y00A01088'),
  (302, 9, 72, N'Y00T00032.Y00A05615'),
  (304, 9, 67, N'Y00T00001.Y00A00764AA01'),
  (308, 9, 65, NULL),
  (309, 9, 73, N'Y00T00001.Y00A00736'),
  (310, 9, 74, N'Y00T00032.Y00A01557'),

  (311, 10, 1, N'Y00T00001.Y00A07364'),
  (312, 10, 2, N'Y00T00032.Y00A01007'),
  (313, 10, 4, NULL),
  (314, 10, 5, N'Y00T00032.Y00A00175'),
  (315, 10, 11, NULL),
  (316, 10, 18, NULL),
  (317, 10, 53, N'Y00T00032.Y00A06001'),
  (318, 10, 60, NULL),
  (319, 10, 54, N'Y00T00032.Y00A01054'),
  
  (320, 10, 3, NULL),
  (321, 10, 6, N'Y00T00001.Y00A07361'),
  (322, 10, 7, NULL),
  (323, 10, 8, NULL),
  (324, 10, 9, NULL),
  (325, 10, 10, NULL),
  (326, 10, 12, N'Y00T00001.Y00A01090'),
  (327, 10, 13, NULL),
  (328, 10, 14, NULL),
  (329, 10, 15, N'Y00T00032.Y00A07342'),
  (330, 10, 16, N'Y00T00001.Y00A00785'),
  (331, 10, 17, NULL),
  (332, 10, 19, NULL),
  (333, 10, 69, N'Y00T00032.Y00A00011AA01'),
  (334, 10, 22, NULL),
  (335, 10, 23, NULL),
  (336, 10, 24, NULL),
  (337, 10, 25, NULL),
  (338, 10, 26, NULL),
  (339, 10, 27, NULL),
  (340, 10, 29, NULL),
  (341, 10, 30, NULL),
  (342, 10, 28, NULL),
  (343, 10, 57, NULL),
  (344, 10, 59, N'Y00T00001.Y00A00825'),  
  (345, 10, 63, N'Y00T00001.Y00A00764'),
  (346, 10, 58, NULL),
  (347, 10, 61, N'Y00T00001.Y00A07363'),
  (348, 10, 62, N'Y00T00001.Y00A07360'),
  (349, 10, 64, N'Y00T00032.Y00A04953AA01'),
  (350, 10, 66, N'Y00T00032.Y00A00011'),
  (351, 10, 21, NULL),
  (353, 10, 71, N'Y00T00032.Y00A01088'),
  (354, 10, 72, N'Y00T00032.Y00A05615'),
  (355, 10, 67, N'Y00T00001.Y00A00764AA01'),
  (356, 10, 65, NULL),
  (357, 10, 73, N'Y00T00001.Y00A00736'),
  (358, 10, 74, N'Y00T00032.Y00A01557')
) 
AS Source (Id, TaskTypeId, FieldId, ComosNestedName) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET TaskTypeId = Source.TaskTypeId, FieldId = Source.FieldId, ComosNestedName = Source.ComosNestedName 
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT (Id, TaskTypeId, FieldId, ComosNestedName) 
VALUES (Id, TaskTypeId, FieldId, ComosNestedName) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;
GO

SET IDENTITY_INSERT [dbo].[TM_TaskTypeFieldMap] OFF;
GO


--:r .\CreateTaskEntityTestData.sql
SET IDENTITY_INSERT [dbo].[TM_Queries] ON;
GO

ALTER TABLE [dbo].[TM_Queries] DISABLE TRIGGER Trigger_TM_Queries_Del
GO

-- Reference Data for TM_TaskType 
MERGE INTO [dbo].[TM_Queries] AS Target
USING (VALUES 
  (1, NULL, N'Shared Queries', NULL, N'{}', N'UserName', 1, 1), 
  (2, 1, N'All tasks', NULL,  N'{"Columns":["Name","Id","CreateDateTime", "StartDateTime", "EndDateTime", "Responsible", "State","TaskType"],"Sorts":[{"FieldName":"Name","Ascending":true}],"Filters":null}', N'UserName', 0, 1),
  (3, 1, N'All annotations', NULL,  N'{"Columns":["Fields.Id","Fields.State","Fields.Responsible","Fields.CreateDateTime","Fields.TaskType","Fields.ChangedDateTime","Fields.Creator"],"Sorts":[],"Filters":[{"Grouping":"","LogicOperator":0,"FieldName":"TaskType","Operator":2,"FilterValue":"Annotation"}]}', N'UserName', 0, 1)
) 
AS Source (Id, ParentId, Name, Description, Query, Owner, IsFolder, IsShared) 
ON Target.Id = Source.Id 

-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET Name = Source.Name, 
		ParentId = Source.ParentId, 
		Description = Source.Description,  
		Query = Source.Query,
		Owner = Source.Owner,
		IsFolder = Source.IsFolder,
		IsShared = Source.IsShared
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT (Id, ParentId, Name, Description, Query, Owner, IsFolder, IsShared) 
VALUES (Id, ParentId, Name, Description, Query, Owner, IsFolder, IsShared) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
    DELETE

OUTPUT $action, Inserted.*, Deleted.*;
GO

ALTER TABLE [dbo].[TM_Queries] ENABLE TRIGGER Trigger_TM_Queries_Del
GO

SET IDENTITY_INSERT [dbo].[TM_Queries] OFF;
GO

SET IDENTITY_INSERT [dbo].[TM_Rules] ON;
GO

-- Merge Standard Rules
MERGE INTO [dbo].[TM_Rules] AS Target
USING (VALUES 
  (1, 5, 9, 1, N'PrioList'),
  (2, 5, 33, 4, N'StateWP'),
  (3, 5, 33, 6, N'StateEvent'),
  (4, 5, 47, 6, N'Priorities'),
  (5, 5, 9, 8, N'PrioList'),
  (6, 5, 57, 8, N'Roles'),
  (7, 5, 9, 9, N'PrioList'),
  (8, 5, 57, 9, N'Roles'),
  (9, 5, 9, 10, N'PrioList'),
  (10, 5, 57, 10, N'Roles')
) 
AS Source ([Id], [RuleType], [FieldId], [TaskTypeId], [Field1]) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET [RuleType] = Source.[RuleType], [FieldId] = Source.[FieldId], [TaskTypeId] = Source.[TaskTypeId], [Field1] = Source.[Field1] 
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT ([Id], [RuleType], [FieldId], [TaskTypeId], [Field1]) 
VALUES ([Id], [RuleType], [FieldId], [TaskTypeId], [Field1]) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;
GO

SET IDENTITY_INSERT [dbo].[TM_Rules] OFF;
GO

SET IDENTITY_INSERT [dbo].[TM_ValueLists] ON;
GO

ALTER TABLE [dbo].[TM_ValueLists] DISABLE TRIGGER [Trigger_TM_ValueList_Del]
GO

MERGE INTO [dbo].[TM_ValueLists] AS Target
USING (VALUES   
  (1,NULL,N'PrioList',N'',N''),
  (2,1,N'1',N'1',N'Very low'),
  (3,1,N'2',N'2',N'Low'),
  (4,1,N'3',N'3',N'Medium'),
  (5,1,N'4',N'4',N'High'),
  (6, NULL, N'Priorities', N'', N''),
  (7, 6, N'1', N'A030', N'Low'),
  (8, 6, N'2', N'A020', N'Medium'),
  (9, 6, N'3', N'A010', N'High'),
  (10, NULL, N'StateEvent', N'', N''),
  (11, 10, N'1', N'0', N'N/A'),
  (12, 10, N'2', N'1', N'New'),
  (13, 10, N'3', N'2', N'For information'),
  (14, 10, N'4', N'3', N'Confirmed'),
  (15, 10, N'5', N'4', N'Suspended'),
  (16, 10, N'6', N'5', N'Completed'),
  (17, 10, N'7', N'6', N'Delegated'),
  (18, NULL, N'StateWP', N'', N''),
  (19, 18, N'1', N'@1', N'Scheduled'),
  (20, 18, N'2', N'@2', N'In progress'),
  (21, 18, N'3', N'@3', N'Tasks completed'),
  (22, 18, N'4', N'@4', N'Completed'),
  (23, NULL, N'Roles', N'', N''),
  (24, 23, N'1', N'0', N'not defined'),
  (25, 23, N'2', N'1', N'Project Manager'),
  (26, 23, N'3', N'2', N'Process Owner'),
  (27, 23, N'4', N'3', N'User Responsible'),
  (28, 23, N'5', N'4', N'Data Owner'),
  (29, 23, N'6', N'5', N'System Owner'),
  (30, 23, N'7', N'6', N'Application Responsible'),
  (31, 23, N'8', N'7', N'Subject Matter Expert'),
  (32, 23, N'9', N'8', N'Technical Manager'),
  (33, 23, N'10', N'9', N'Design Lead'),
  (34, 23, N'11', N'10', N'Business Analyst'),
  (35, 23, N'12', N'11', N'Infrastructure Lead/Responsible'),
  (36, 23, N'13', N'12', N'Enterprise Cybersecurity and Risk'),
  (37, 23, N'14', N'13', N'Test Lead'),
  (38, 23, N'15', N'14', N'Validation Responsible'),
  (39, 23, N'16', N'15', N'BT Quality Management Delegate'),
  (40, 23, N'17', N'16', N'Quality Assurance (for GxP relevant Systems)'),
  (41, 23, N'18', N'17', N'Tester'),
  (42, 23, N'19', N'18', N'Test Verifier'),
  (43, 23, N'20', N'19', N'Quality Management Delegate'),
  (44, 23, N'21', N'20', N'Safety'),
  (45, 23, N'22', N'21', N'Verification / Validation Responsible'),
  (46, 23, N'23', N'22', N'Scan Reviewer'),
  (47, 23, N'24', N'23', N'Reviewer')
)
AS Source ([Id], [ParentId], [Name], [Value], [Description]) 
ON Target.Id = Source.Id 
-- update matched rows 
WHEN MATCHED THEN 
UPDATE SET [ParentId] = Source.[ParentId], [Name] = Source.[Name], [Value] = Source.[Value], [Description] = Source.[Description] 
-- insert new rows 
WHEN NOT MATCHED BY TARGET THEN 
INSERT ([Id], [ParentId], [Name], [Value], [Description]) 
VALUES ([Id], [ParentId], [Name], [Value], [Description]) 
-- delete rows that are in the target but not the source 
WHEN NOT MATCHED BY SOURCE THEN 
DELETE;

GO

ALTER TABLE [dbo].[TM_ValueLists] ENABLE TRIGGER [Trigger_TM_ValueList_Del]
GO

SET IDENTITY_INSERT [dbo].[TM_ValueLists] OFF;
GO

GO
DECLARE @VarDecimalSupported AS BIT;

SELECT @VarDecimalSupported = 0;

IF ((ServerProperty(N'EngineEdition') = 3)
    AND (((@@microsoftversion / power(2, 24) = 9)
          AND (@@microsoftversion & 0xffff >= 3024))
         OR ((@@microsoftversion / power(2, 24) = 10)
             AND (@@microsoftversion & 0xffff >= 1600))))
    SELECT @VarDecimalSupported = 1;

IF (@VarDecimalSupported > 0)
    BEGIN
        EXECUTE sp_db_vardecimal_storage_format N'$(DatabaseName)', 'ON';
    END


GO
PRINT N'Update complete.';


GO
